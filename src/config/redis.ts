import { Redis } from '@upstash/redis';

let redis: Redis | null = null;

export const getRedis = (): Redis => {
  if (!redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
      throw new Error(
        'Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN in environment variables'
      );
    }

    redis = new Redis({ url, token });
    console.log('✅ [REDIS] Upstash Redis client initialized');
  }
  return redis;
};

/**
 * Check if Redis is configured
 */
export function isRedisConfigured(): boolean {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

// Redis key helpers
export const AVAILABILITY_KEY_PREFIX = 'creator:availability:';

export const availabilityKey = (firebaseUid: string): string =>
  `${AVAILABILITY_KEY_PREFIX}${firebaseUid}`;

// Call billing Redis key helpers
export const CALL_SESSION_PREFIX = 'call:session:';
export const CALL_USER_COINS_PREFIX = 'call:user_coins:';
export const CALL_CREATOR_EARNINGS_PREFIX = 'call:creator_earnings:';

export const callSessionKey = (callId: string): string =>
  `${CALL_SESSION_PREFIX}${callId}`;

export const callUserCoinsKey = (callId: string): string =>
  `${CALL_USER_COINS_PREFIX}${callId}`;

export const callCreatorEarningsKey = (callId: string): string =>
  `${CALL_CREATOR_EARNINGS_PREFIX}${callId}`;

// Creator dashboard cache Redis key helpers
export const CREATOR_DASHBOARD_PREFIX = 'creator:dashboard:';
export const CREATOR_DASHBOARD_TTL = 60; // 60 seconds cache

export const creatorDashboardKey = (userId: string): string =>
  `${CREATOR_DASHBOARD_PREFIX}${userId}`;

/**
 * Invalidate creator dashboard cache.
 * Called after billing settlement, task claim, etc.
 */
export const invalidateCreatorDashboard = async (userId: string): Promise<void> => {
  try {
    const redis = getRedis();
    await redis.del(creatorDashboardKey(userId));
    console.log(`🗑️ [REDIS] Invalidated dashboard cache for creator ${userId}`);
  } catch (err) {
    console.error(`⚠️ [REDIS] Failed to invalidate dashboard cache for ${userId}:`, err);
  }
};

// ── Admin Dashboard Cache ────────────────────────────────────────────────
// Versioned keys — bump suffix when aggregation shape changes.
export const ADMIN_CACHE_PREFIX = 'admin:';
export const ADMIN_CACHE_TTL = 60; // 60 seconds

export const adminCacheKey = (section: string): string =>
  `${ADMIN_CACHE_PREFIX}${section}:v1`;

/**
 * Invalidate one or more admin cache keys.
 * Call after: call settlement, coin adjustment, refund, creator promotion/deletion.
 */
export const invalidateAdminCaches = async (
  ...sections: string[]
): Promise<void> => {
  try {
    const redis = getRedis();
    const keys = sections.length > 0
      ? sections.map(adminCacheKey)
      : ['overview', 'creators_performance', 'coins'].map(adminCacheKey);
    await Promise.all(keys.map((k) => redis.del(k)));
    console.log(`🗑️ [REDIS] Invalidated admin caches: ${sections.length > 0 ? sections.join(', ') : 'all'}`);
  } catch (err) {
    console.error('⚠️ [REDIS] Failed to invalidate admin caches:', err);
  }
};
