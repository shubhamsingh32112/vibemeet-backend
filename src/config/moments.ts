/**
 * Moments / Stories feature configuration.
 */

function readNumberEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface MomentsConfig {
  enabled: boolean;
  creatorRevenueShare: number;
  photoPriceCoins: number;
  videoPriceCoins: number;
  photoUploadRewardCoins: number;
  videoUploadRewardCoins: number;
  entitlementVersion: number;
  storyImageMaxBytes: number;
  storyVideoMaxSeconds: number;
  reelImageMaxBytes: number;
  reelVideoMaxSeconds: number;
  purchaseLockTtlSec: number;
  storyTtlHours: number;
  rateLimitPurchaseMax: number;
  rateLimitPurchaseWindowSec: number;
  rateLimitFollowMax: number;
  rateLimitFollowWindowSec: number;
  rateLimitUploadMax: number;
  rateLimitUploadWindowSec: number;
  rateLimitStoryViewMax: number;
  rateLimitStoryViewWindowSec: number;
  feedCacheTtlSec: number;
  impressionDedupTtlSec: number;
  fanoutOnUpload: boolean;
  feedWarmerEnabled: boolean;
  feedWarmerFollowerThreshold: number;
  feedWarmerTopFollowers: number;
  followingFeedCacheTtlSec: number;
}

let cached: MomentsConfig | null = null;

export function isMomentsEnabled(): boolean {
  return process.env.USE_MOMENTS === 'true';
}

export function getMomentsConfig(): MomentsConfig {
  if (cached) return cached;
  cached = {
    enabled: isMomentsEnabled(),
    creatorRevenueShare: readNumberEnv('MOMENTS_CREATOR_REVENUE_SHARE', 0.5),
    photoPriceCoins: readIntEnv('MOMENTS_PHOTO_PRICE_COINS', 10),
    videoPriceCoins: readIntEnv('MOMENTS_VIDEO_PRICE_COINS', 30),
    photoUploadRewardCoins: readIntEnv('MOMENTS_PHOTO_UPLOAD_REWARD_COINS', 10),
    videoUploadRewardCoins: readIntEnv('MOMENTS_VIDEO_UPLOAD_REWARD_COINS', 30),
    entitlementVersion: readIntEnv('MOMENTS_ENTITLEMENT_VERSION', 1),
    storyImageMaxBytes: readIntEnv('MOMENTS_STORY_IMAGE_MAX_BYTES', 10 * 1024 * 1024),
    storyVideoMaxSeconds: readIntEnv('MOMENTS_STORY_VIDEO_MAX_SECONDS', 90),
    reelImageMaxBytes: readIntEnv('MOMENTS_REEL_IMAGE_MAX_BYTES', 20 * 1024 * 1024),
    reelVideoMaxSeconds: readIntEnv('MOMENTS_REEL_VIDEO_MAX_SECONDS', 180),
    purchaseLockTtlSec: readIntEnv('MOMENTS_PURCHASE_LOCK_TTL_SEC', 8),
    storyTtlHours: readIntEnv('MOMENTS_STORY_TTL_HOURS', 24),
    rateLimitPurchaseMax: readIntEnv('MOMENTS_RATE_LIMIT_PURCHASE_MAX', 5),
    rateLimitPurchaseWindowSec: readIntEnv('MOMENTS_RATE_LIMIT_PURCHASE_WINDOW_SEC', 60),
    rateLimitFollowMax: readIntEnv('MOMENTS_RATE_LIMIT_FOLLOW_MAX', 30),
    rateLimitFollowWindowSec: readIntEnv('MOMENTS_RATE_LIMIT_FOLLOW_WINDOW_SEC', 3600),
    rateLimitUploadMax: readIntEnv('MOMENTS_RATE_LIMIT_UPLOAD_MAX', 20),
    rateLimitUploadWindowSec: readIntEnv('MOMENTS_RATE_LIMIT_UPLOAD_WINDOW_SEC', 3600),
    rateLimitStoryViewMax: readIntEnv('MOMENTS_RATE_LIMIT_STORY_VIEW_MAX', 120),
    rateLimitStoryViewWindowSec: readIntEnv('MOMENTS_RATE_LIMIT_STORY_VIEW_WINDOW_SEC', 60),
    feedCacheTtlSec: readIntEnv('MOMENTS_FEED_CACHE_TTL_SEC', 30),
    impressionDedupTtlSec: readIntEnv('MOMENTS_IMPRESSION_DEDUP_TTL_SEC', 30 * 60),
    fanoutOnUpload: process.env.MOMENTS_FANOUT_ON_UPLOAD === 'true',
    feedWarmerEnabled: process.env.MOMENTS_FEED_WARMER === 'true',
    feedWarmerFollowerThreshold: readIntEnv('MOMENTS_FEED_WARMER_FOLLOWER_THRESHOLD', 1000),
    feedWarmerTopFollowers: readIntEnv('MOMENTS_FEED_WARMER_TOP_FOLLOWERS', 50),
    followingFeedCacheTtlSec: readIntEnv('MOMENTS_FOLLOWING_FEED_CACHE_TTL_SEC', 7 * 24 * 3600),
  };
  return cached;
}

export class MomentsDisabledError extends Error {
  readonly status = 503;
  readonly code = 'FEATURE_DISABLED';

  constructor() {
    super('Moments is not available yet');
    this.name = 'MomentsDisabledError';
  }
}

export function assertMomentsEnabled(): void {
  if (!isMomentsEnabled()) {
    throw new MomentsDisabledError();
  }
}

export function respondMomentsDisabled(
  error: unknown,
  res: { status: (code: number) => { json: (body: unknown) => void } },
): boolean {
  if (error instanceof MomentsDisabledError) {
    res.status(error.status).json({
      success: false,
      error: error.message,
      code: error.code,
    });
    return true;
  }
  return false;
}

export function __resetMomentsConfigForTests(): void {
  cached = null;
}
