/**
 * Cloudflare Stream configuration loader.
 */

function readIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface CloudflareStreamConfig {
  accountId: string;
  apiToken: string;
  customerCode: string;
  signingKeyId: string;
  signingKeyJwkBase64: string;
  webhookSecret: string;
  tokenTtlSec: number;
}

let cachedConfig: CloudflareStreamConfig | null = null;

export function isCloudflareStreamEnabled(): boolean {
  return process.env.USE_CLOUDFLARE_STREAM === 'true';
}

export function tryGetCloudflareStreamConfig(): CloudflareStreamConfig | null {
  if (cachedConfig) return cachedConfig;

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_STREAM_API_TOKEN?.trim();
  const customerCode = process.env.CLOUDFLARE_STREAM_CUSTOMER_CODE?.trim();
  const signingKeyId = process.env.CLOUDFLARE_STREAM_SIGNING_KEY_ID?.trim() || '';
  const signingKeyJwkBase64 = process.env.CLOUDFLARE_STREAM_SIGNING_KEY_JWK?.trim() || '';
  const webhookSecret = process.env.CLOUDFLARE_STREAM_WEBHOOK_SECRET?.trim() || '';

  if (!accountId || !apiToken || !customerCode) {
    return null;
  }

  cachedConfig = {
    accountId,
    apiToken,
    customerCode,
    signingKeyId,
    signingKeyJwkBase64,
    webhookSecret,
    tokenTtlSec: readIntEnv('CLOUDFLARE_STREAM_TOKEN_TTL_SEC', 3600),
  };
  return cachedConfig;
}

export function getCloudflareStreamConfig(): CloudflareStreamConfig {
  const cfg = tryGetCloudflareStreamConfig();
  if (!cfg) {
    throw new Error(
      'Cloudflare Stream is not configured. Set CLOUDFLARE_ACCOUNT_ID, ' +
        'CLOUDFLARE_STREAM_API_TOKEN, and CLOUDFLARE_STREAM_CUSTOMER_CODE.',
    );
  }
  return cfg;
}

export class CloudflareStreamDisabledError extends Error {
  readonly code = 'CLOUDFLARE_STREAM_DISABLED';
  constructor(reason: string) {
    super(`Cloudflare Stream pipeline disabled: ${reason}`);
  }
}

export function assertCloudflareStreamEnabled(): CloudflareStreamConfig {
  if (!isCloudflareStreamEnabled()) {
    throw new CloudflareStreamDisabledError('USE_CLOUDFLARE_STREAM is not "true"');
  }
  const cfg = tryGetCloudflareStreamConfig();
  if (!cfg) {
    throw new CloudflareStreamDisabledError('credentials missing');
  }
  return cfg;
}

export function __resetCloudflareStreamConfigForTests(): void {
  cachedConfig = null;
}
