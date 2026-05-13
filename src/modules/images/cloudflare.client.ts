/**
 * Resilient Cloudflare Images API client.
 *
 * Hard requirements per Phase 1 / §6.11:
 *   - Retry with exponential backoff (3 attempts) on 5xx + network errors.
 *   - Circuit breaker (opossum) opens after sustained failures so callers
 *     can return HTTP 503 instead of hammering Cloudflare.
 *   - Metrics: every call emits image.cloudflare.{operation}.{ok|fail}.
 *   - Timeouts: 15s for control plane (variant, delete, metadata),
 *               30s for create-direct-upload, 60s for image-byte downloads.
 *
 * Operations:
 *   - createDirectUpload   POST /accounts/{id}/images/v2/direct_upload
 *   - getImageMetadata     GET  /accounts/{id}/images/v1/{imageId}
 *   - deleteImage          DEL  /accounts/{id}/images/v1/{imageId}
 *   - downloadImageBytes   GET  /accounts/{id}/images/v1/{imageId}/blob
 */

import axios, { type AxiosError, type AxiosInstance } from 'axios';
import FormData from 'form-data';
import CircuitBreaker from 'opossum';
import { getCloudflareConfig } from '../../config/cloudflare';
import { logError, logWarning } from '../../utils/logger';
import { bumpImageCounter, recordImageMetric } from './image-metrics';

interface DirectUploadResult {
  imageId: string;
  uploadURL: string;
}

interface ImageMetadata {
  id: string;
  filename: string;
  uploaded: string;
  variants: string[];
  meta?: Record<string, string>;
  requireSignedURLs?: boolean;
}

interface ApiEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages?: unknown[];
  result?: T;
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 200;

function isRetryable(error: unknown): boolean {
  const ax = error as AxiosError;
  if (!ax.isAxiosError) return false;
  if (!ax.response) return true; // network / timeout
  const status = ax.response.status;
  return status >= 500 || status === 429;
}

function describe(error: AxiosError): string {
  const status = error.response?.status ?? 'network';
  const body = error.response?.data;
  if (body && typeof body === 'object') {
    return `HTTP ${status}: ${JSON.stringify(body)}`;
  }
  return `HTTP ${status}: ${error.message}`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await fn();
      bumpImageCounter('cloudflare.ok', { operation, attempt });
      return result;
    } catch (error) {
      lastError = error;
      const retryable = isRetryable(error);
      bumpImageCounter('cloudflare.fail', { operation, attempt, retryable });
      if (!retryable || attempt === MAX_ATTEMPTS) {
        break;
      }
      const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      logWarning('Cloudflare Images call failed; retrying', {
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
  breaker = new CircuitBreaker(
    async (operation: string, fn: () => Promise<unknown>) => withRetry(operation, fn),
    {
      timeout: 65_000,
      errorThresholdPercentage: 50,
      volumeThreshold: 5,
      rollingCountTimeout: 30_000,
      rollingCountBuckets: 10,
      resetTimeout: 30_000,
      name: 'cloudflare-images',
    },
  );
  breaker.on('open', () => {
    bumpImageCounter('cloudflare.breaker_open');
    logError('Cloudflare Images circuit breaker OPEN', new Error('cloudflare_circuit_open'), {
      impact: 'image-pipeline endpoints will return 503 until breaker resets',
    });
  });
  breaker.on('halfOpen', () => bumpImageCounter('cloudflare.breaker_half_open'));
  breaker.on('close', () => bumpImageCounter('cloudflare.breaker_close'));
  return breaker;
}

async function callBreaker<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  const b = getBreaker();
  return b.fire(operation, fn as () => Promise<unknown>) as Promise<T>;
}

function buildHttpClient(): AxiosInstance {
  const { apiToken } = getCloudflareConfig();
  return axios.create({
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: 'application/json',
    },
  });
}

function accountUrl(suffix: string): string {
  const { accountId } = getCloudflareConfig();
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}${suffix}`;
}

export class CloudflareImagesError extends Error {
  readonly status: number;
  readonly cause: unknown;
  constructor(message: string, status: number, cause?: unknown) {
    super(message);
    this.status = status;
    this.cause = cause;
  }
}

export class CloudflareImagesCircuitOpenError extends CloudflareImagesError {
  constructor() {
    super('cloudflare images circuit open', 503);
  }
}

function wrapAxiosError(operation: string, error: unknown): never {
  if ((error as Error).message === 'Breaker is open') {
    throw new CloudflareImagesCircuitOpenError();
  }
  const ax = error as AxiosError;
  if (ax.isAxiosError) {
    const status = ax.response?.status ?? 502;
    throw new CloudflareImagesError(`${operation}: ${describe(ax)}`, status, ax);
  }
  throw new CloudflareImagesError(`${operation}: ${(error as Error).message}`, 500, error);
}

/**
 * Request a Cloudflare direct-upload URL. The client uploads the bytes
 * directly to Cloudflare using the returned `uploadURL` — backend never
 * proxies image bytes.
 */
export async function createDirectUpload(args: {
  metadata?: Record<string, string>;
  requireSignedURLs?: boolean;
}): Promise<DirectUploadResult> {
  const operation = 'create_direct_upload';
  const http = buildHttpClient();
  const startedAt = Date.now();
  try {
    return await callBreaker(operation, async () => {
      const form = new FormData();
      if (args.metadata) form.append('metadata', JSON.stringify(args.metadata));
      form.append('requireSignedURLs', String(Boolean(args.requireSignedURLs)));

      const { data } = await http.post<ApiEnvelope<DirectUploadResult & { id: string }>>(
        accountUrl('/images/v2/direct_upload'),
        form,
        { timeout: 30_000, headers: form.getHeaders() },
      );
      if (!data.success || !data.result) {
        throw new Error(`cloudflare error: ${JSON.stringify(data.errors)}`);
      }
      const r = data.result;
      return {
        imageId: (r as { id?: string }).id ?? r.imageId,
        uploadURL: r.uploadURL,
      };
    });
  } catch (error) {
    wrapAxiosError(operation, error);
  } finally {
    recordImageMetric('cloudflare.duration_ms', Date.now() - startedAt, { operation });
  }
}

export async function getImageMetadata(imageId: string): Promise<ImageMetadata> {
  const operation = 'get_image_metadata';
  const http = buildHttpClient();
  const startedAt = Date.now();
  try {
    return await callBreaker(operation, async () => {
      const { data } = await http.get<ApiEnvelope<ImageMetadata>>(
        accountUrl(`/images/v1/${encodeURIComponent(imageId)}`),
        { timeout: 15_000 },
      );
      if (!data.success || !data.result) {
        throw new Error(`cloudflare error: ${JSON.stringify(data.errors)}`);
      }
      return data.result;
    });
  } catch (error) {
    wrapAxiosError(operation, error);
  } finally {
    recordImageMetric('cloudflare.duration_ms', Date.now() - startedAt, { operation });
  }
}

export async function deleteImage(imageId: string): Promise<void> {
  const operation = 'delete_image';
  const http = buildHttpClient();
  const startedAt = Date.now();
  try {
    await callBreaker(operation, async () => {
      const { data } = await http.delete<ApiEnvelope<unknown>>(
        accountUrl(`/images/v1/${encodeURIComponent(imageId)}`),
        { timeout: 15_000 },
      );
      if (!data.success) {
        throw new Error(`cloudflare error: ${JSON.stringify(data.errors)}`);
      }
    });
  } catch (error) {
    // 404 = already gone → treat as success
    if (error instanceof CloudflareImagesError && error.status === 404) {
      bumpImageCounter('cloudflare.delete_idempotent', { reason: 'not_found' });
      return;
    }
    wrapAxiosError(operation, error);
  } finally {
    recordImageMetric('cloudflare.duration_ms', Date.now() - startedAt, { operation });
  }
}

/**
 * Pull raw image bytes (for blurhash generation, perceptual hashing).
 * Returns the public-variant bytes, capped at ~10 MB by Cloudflare itself.
 */
export async function downloadImageBytes(imageId: string, variant: string = 'public'): Promise<Buffer> {
  const operation = 'download_image_bytes';
  const startedAt = Date.now();
  const { apiToken } = getCloudflareConfig();
  try {
    return await callBreaker(operation, async () => {
      const url = accountUrl(`/images/v1/${encodeURIComponent(imageId)}/blob`);
      const response = await axios.get<ArrayBuffer>(url, {
        timeout: 60_000,
        responseType: 'arraybuffer',
        headers: {
          Authorization: `Bearer ${apiToken}`,
        },
      });
      // Variant param is only required for non-default downloads
      void variant;
      return Buffer.from(response.data);
    });
  } catch (error) {
    wrapAxiosError(operation, error);
  } finally {
    recordImageMetric('cloudflare.duration_ms', Date.now() - startedAt, { operation });
  }
}

/** Useful in tests to bypass the circuit breaker. */
export function __resetCloudflareClientForTests(): void {
  breaker = null;
}
