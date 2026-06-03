import axios, { type AxiosError, type AxiosInstance } from 'axios';
import CircuitBreaker from 'opossum';
import {
  assertCloudflareStreamEnabled,
  getCloudflareStreamConfig,
  tryGetCloudflareStreamConfig,
  type CloudflareStreamConfig,
} from '../../config/cloudflare-stream';
import { logError, logWarning } from '../../utils/logger';
import { bumpStreamCounter } from './stream-metrics';
import type { ContentClass } from '../media-shared/types';

interface ApiEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result?: T;
}

interface DirectUploadResult {
  uid: string;
  uploadURL: string;
}

interface StreamVideoDetails {
  uid: string;
  status?: { state?: string };
  duration?: number;
  thumbnail?: string;
  meta?: Record<string, string>;
}

function readIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_ATTEMPTS = readIntEnv('CF_STREAM_RETRY_MAX', 3);
const BASE_BACKOFF_MS = 200;
const DEGRADED_MODE = process.env.CF_STREAM_DEGRADED_MODE !== 'false';

export class CloudflareStreamError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class CloudflareStreamCircuitOpenError extends CloudflareStreamError {
  constructor() {
    super('CLOUDFLARE_STREAM_UNAVAILABLE', 503);
  }
}

function isRetryable(error: unknown): boolean {
  const ax = error as AxiosError;
  if (!ax.isAxiosError) return false;
  if (!ax.response) return true;
  const status = ax.response.status;
  return status >= 500 || status === 429;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await fn();
      bumpStreamCounter('cloudflare.ok', { operation, attempt: String(attempt) });
      return result;
    } catch (error) {
      lastError = error;
      const retryable = isRetryable(error);
      bumpStreamCounter('cloudflare.fail', {
        operation,
        attempt: String(attempt),
        retryable: retryable ? 'true' : 'false',
      });
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      logWarning('Cloudflare Stream call failed; retrying', {
        operation,
        attempt,
        delay,
        error: (error as Error).message,
      });
      await sleep(delay);
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error(`${operation} failed after ${MAX_ATTEMPTS} attempts`);
}

let breaker: CircuitBreaker<[string, () => Promise<unknown>], unknown> | null = null;

function getBreaker(): CircuitBreaker<[string, () => Promise<unknown>], unknown> {
  if (breaker) return breaker;
  const resetTimeout = readIntEnv('CF_STREAM_BREAKER_RESET_MS', 30_000);
  breaker = new CircuitBreaker(
    async (operation: string, fn: () => Promise<unknown>) => withRetry(operation, fn),
    {
      timeout: 35_000,
      errorThresholdPercentage: 50,
      volumeThreshold: readIntEnv('CF_STREAM_BREAKER_THRESHOLD', 5),
      rollingCountTimeout: 30_000,
      rollingCountBuckets: 10,
      resetTimeout,
      name: 'cloudflare-stream',
    },
  );
  breaker.on('open', () => {
    bumpStreamCounter('cloudflare.breaker_open');
    logError('Cloudflare Stream circuit breaker OPEN', new Error('cloudflare_stream_circuit_open'), {
      impact: 'stream upload endpoints will return 503 until breaker resets',
    });
  });
  breaker.on('halfOpen', () => bumpStreamCounter('cloudflare.breaker_half_open'));
  breaker.on('close', () => bumpStreamCounter('cloudflare.breaker_close'));
  return breaker;
}

async function callBreaker<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  if (!DEGRADED_MODE) {
    return withRetry(operation, fn);
  }
  const b = getBreaker();
  try {
    return (await b.fire(operation, fn as () => Promise<unknown>)) as T;
  } catch (error) {
    if ((error as Error).message === 'Breaker is open') {
      throw new CloudflareStreamCircuitOpenError();
    }
    throw error;
  }
}

export function isCloudflareStreamCircuitOpen(): boolean {
  if (!DEGRADED_MODE || !breaker) return false;
  return breaker.opened;
}

export function __resetStreamBreakerForTests(): void {
  breaker = null;
}

function client(cfg: CloudflareStreamConfig, timeoutMs: number): AxiosInstance {
  return axios.create({
    baseURL: `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/stream`,
    headers: {
      Authorization: `Bearer ${cfg.apiToken}`,
      'Content-Type': 'application/json',
    },
    timeout: timeoutMs,
  });
}

function wrapAxiosError(operation: string, error: unknown): never {
  if (error instanceof CloudflareStreamCircuitOpenError) throw error;
  const ax = error as AxiosError;
  if (ax.isAxiosError && ax.response) {
    throw new CloudflareStreamError(
      `${operation}: ${JSON.stringify(ax.response.data) || ax.message}`,
      ax.response.status,
    );
  }
  if (error instanceof CloudflareStreamError) throw error;
  throw new CloudflareStreamError(`${operation}: ${(error as Error).message}`, 502);
}

export async function createStreamDirectUpload(input: {
  contentClass: ContentClass;
  maxDurationSeconds: number;
}): Promise<DirectUploadResult> {
  const cfg = assertCloudflareStreamEnabled();
  const operation = 'create_direct_upload';
  try {
    return await callBreaker(operation, async () => {
      const http = client(cfg, 15_000);
      const { data } = await http.post<ApiEnvelope<DirectUploadResult>>('/direct_upload', {
        maxDurationSeconds: input.maxDurationSeconds,
        requireSignedURLs: true,
        meta: { contentClass: input.contentClass },
      });
      if (!data.success || !data.result?.uid || !data.result.uploadURL) {
        throw new CloudflareStreamError(
          data.errors?.[0]?.message || 'direct_upload failed',
          502,
        );
      }
      return data.result;
    });
  } catch (error) {
    wrapAxiosError(operation, error);
  }
}

export async function getStreamVideoDetails(videoUid: string): Promise<StreamVideoDetails> {
  const cfg = assertCloudflareStreamEnabled();
  const operation = 'get_video_details';
  try {
    return await callBreaker(operation, async () => {
      const http = client(cfg, 10_000);
      const { data } = await http.get<ApiEnvelope<StreamVideoDetails>>(`/${videoUid}`);
      if (!data.success || !data.result) {
        throw new CloudflareStreamError(
          data.errors?.[0]?.message || 'get video failed',
          502,
        );
      }
      return data.result;
    });
  } catch (error) {
    wrapAxiosError(operation, error);
  }
}

export async function deleteStreamVideo(videoUid: string): Promise<void> {
  const cfg = tryGetCloudflareStreamConfig();
  if (!cfg) return;
  const operation = 'delete_video';
  try {
    await callBreaker(operation, async () => {
      const http = client(cfg, 10_000);
      await http.delete(`/${videoUid}`);
    });
  } catch (error) {
    logWarning('Stream video delete failed', {
      videoUid,
      error: (error as Error).message,
    });
  }
}

export function buildStreamThumbnailUrl(videoUid: string, height = 600): string {
  const cfg = getCloudflareStreamConfig();
  return `https://customer-${cfg.customerCode}.cloudflarestream.com/${videoUid}/thumbnails/thumbnail.jpg?time=1s&height=${height}`;
}

export async function headUrlOk(url: string): Promise<boolean> {
  if (isCloudflareStreamCircuitOpen()) return false;
  try {
    const res = await axios.head(url, { timeout: 5_000, validateStatus: () => true });
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}
