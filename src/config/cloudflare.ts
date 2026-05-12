/**
 * Cloudflare Images configuration loader.
 *
 * Source of truth for:
 * - Account credentials (account id, account hash, API token)
 * - Delivery host (default: imagedelivery.net)
 * - Upload byte ceiling (default: 10 MB)
 * - Anti-abuse quotas (avatar/day, gallery/hour)
 * - Feature flag (USE_CLOUDFLARE_IMAGES) and moderation default
 *
 * NOTE: `getCloudflareConfig()` validates lazily so dev environments without
 * Cloudflare credentials can still boot. Callers in hot paths should
 * use `assertCloudflareEnabled()` to fail fast with HTTP 503 when the
 * feature flag is off or credentials are missing.
 */

export interface CloudflareConfig {
  accountId: string;
  accountHash: string;
  apiToken: string;
  deliveryHost: string;
  maxUploadBytes: number;
}

export interface ImageQuotaConfig {
  avatarPerDay: number;
  galleryPerHour: number;
}

const DEFAULT_DELIVERY_HOST = 'imagedelivery.net';
const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const DEFAULT_AVATAR_QUOTA = 5;
const DEFAULT_GALLERY_QUOTA = 20;

let cachedConfig: CloudflareConfig | null = null;

export function isCloudflareImagesEnabled(): boolean {
  return process.env.USE_CLOUDFLARE_IMAGES === 'true';
}

export function isImageModerationPendingByDefault(): boolean {
  return process.env.IMAGE_MODERATION_PENDING_BY_DEFAULT === 'true';
}

function readNumberEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function tryGetCloudflareConfig(): CloudflareConfig | null {
  if (cachedConfig) return cachedConfig;

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const accountHash = process.env.CLOUDFLARE_ACCOUNT_HASH?.trim();
  const apiToken = process.env.CLOUDFLARE_IMAGES_API_TOKEN?.trim();

  if (!accountId || !accountHash || !apiToken) {
    return null;
  }

  cachedConfig = {
    accountId,
    accountHash,
    apiToken,
    deliveryHost: (process.env.CLOUDFLARE_IMAGES_DELIVERY_HOST?.trim() || DEFAULT_DELIVERY_HOST),
    maxUploadBytes: readNumberEnv('CLOUDFLARE_IMAGES_MAX_UPLOAD_BYTES', DEFAULT_MAX_UPLOAD_BYTES),
  };
  return cachedConfig;
}

export function getCloudflareConfig(): CloudflareConfig {
  const config = tryGetCloudflareConfig();
  if (!config) {
    throw new Error(
      'Cloudflare Images is not configured. Set CLOUDFLARE_ACCOUNT_ID, ' +
        'CLOUDFLARE_ACCOUNT_HASH, and CLOUDFLARE_IMAGES_API_TOKEN.',
    );
  }
  return config;
}

export class CloudflareImagesDisabledError extends Error {
  readonly code = 'CLOUDFLARE_IMAGES_DISABLED';
  constructor(reason: string) {
    super(`Cloudflare Images pipeline disabled: ${reason}`);
  }
}

/**
 * Enforces both the feature flag AND credential presence.
 * Throws `CloudflareImagesDisabledError` when either gate is closed.
 * Callers (controllers) should map this to HTTP 503.
 */
export function assertCloudflareEnabled(): CloudflareConfig {
  if (!isCloudflareImagesEnabled()) {
    throw new CloudflareImagesDisabledError('USE_CLOUDFLARE_IMAGES is not "true"');
  }
  const cfg = tryGetCloudflareConfig();
  if (!cfg) {
    throw new CloudflareImagesDisabledError('credentials missing');
  }
  return cfg;
}

export function getImageQuotaConfig(): ImageQuotaConfig {
  return {
    avatarPerDay: readNumberEnv('IMAGE_QUOTA_AVATAR_PER_DAY', DEFAULT_AVATAR_QUOTA),
    galleryPerHour: readNumberEnv('IMAGE_QUOTA_GALLERY_PER_HOUR', DEFAULT_GALLERY_QUOTA),
  };
}

/** Test-only escape hatch. Do not call from production code. */
export function __resetCloudflareConfigForTests(): void {
  cachedConfig = null;
}
