import Redis from 'ioredis';
import { logInfo, logError } from '../utils/logger';

let redis: Redis | null = null;

export const getRedis = (): Redis => {
  if (!redis) {
    // Railway Redis connection - supports both REDIS_URL and individual variables
    const redisUrl = process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL;
    
    if (redisUrl) {
      // Use connection URL if provided
      redis = new Redis(redisUrl, {
        retryStrategy: (times) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        maxRetriesPerRequest: 3,
      });
      logInfo('Railway Redis client initialized from URL', {
        url: redisUrl.replace(/:[^:@]+@/, ':****@'), // Mask password in logs
      });
    } else {
      // Fall back to individual connection parameters
      const host = process.env.REDISHOST;
      const port = parseInt(process.env.REDISPORT || '6379', 10);
      const password = process.env.REDIS_PASSWORD || process.env.REDISPASSWORD;
      const username = process.env.REDISUSER;

      if (!host) {
        throw new Error(
          'Missing Redis configuration. Provide either REDIS_URL/REDIS_PUBLIC_URL or REDISHOST environment variable'
        );
      }

      redis = new Redis({
        host,
        port,
        password,
        username,
        retryStrategy: (times) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        maxRetriesPerRequest: 3,
      });
      logInfo('Railway Redis client initialized from individual parameters', {
        host,
        port,
        username: username || 'default',
      });
    }
  }
  return redis;
};

/**
 * Check if Redis is configured
 */
export function isRedisConfigured(): boolean {
  // Check for Railway Redis variables
  return !!(
    process.env.REDIS_URL ||
    process.env.REDIS_PUBLIC_URL ||
    process.env.REDISHOST
  );
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

// Idempotency keys for billing ticks
export const IDEMPOTENCY_PREFIX = 'idempotency:billing:';
export const idempotencyKey = (callId: string, timestamp: number, second: number): string =>
  `${IDEMPOTENCY_PREFIX}${callId}:${timestamp}:${second}`;

// Active billing calls tracking (sorted set - score = next billing timestamp in ms)
export const ACTIVE_BILLING_CALLS_KEY = 'billing:active_calls';

// 🔥 FIX 1: In-memory state maps moved to Redis
// Active calls by user (firebaseUid → callId)
export const ACTIVE_CALL_BY_USER_PREFIX = 'active:call:user:';
export const activeCallByUserKey = (firebaseUid: string): string =>
  `${ACTIVE_CALL_BY_USER_PREFIX}${firebaseUid}`;

// Pending call ends (calls waiting for session to be created)
export const PENDING_CALL_ENDS_KEY = 'pending:call:ends';
export const pendingCallEndKey = (callId: string): string =>
  `${PENDING_CALL_ENDS_KEY}:${callId}`;

// Settled calls tracking (to prevent duplicate settlements)
export const SETTLED_CALL_PREFIX = 'settled:call:';
export const settledCallKey = (callId: string): string =>
  `${SETTLED_CALL_PREFIX}${callId}`;

// TTLs for state maps
export const ACTIVE_CALL_BY_USER_TTL = 7200; // 2 hours (same as call session)
export const PENDING_CALL_END_TTL = 60; // 60 seconds
export const SETTLED_CALL_TTL = 300; // 5 minutes

// 🔥 FIX 3: Distributed lock for batch processor
export const BATCH_PROCESSOR_LOCK_KEY = 'lock:billing:batch_processor';
export const BATCH_PROCESSOR_LOCK_TTL = 2; // 2 seconds (renewed each tick)

// 🔥 FIX 5: Dead letter queue for failed billing ticks
export const DLQ_BILLING_PREFIX = 'dlq:billing:failed:';
export const dlqBillingKey = (callId: string, timestamp: number): string =>
  `${DLQ_BILLING_PREFIX}${callId}:${timestamp}`;
export const DLQ_BILLING_TTL = 86400; // 24 hours

// Webhook idempotency keys (to prevent duplicate processing)
export const WEBHOOK_IDEMPOTENCY_PREFIX = 'idempotency:webhook:';
export const webhookIdKey = (eventId: string): string =>
  `${WEBHOOK_IDEMPOTENCY_PREFIX}${eventId}`;
export const WEBHOOK_IDEMPOTENCY_TTL = 60 * 60; // 1 hour

// Reconciliation job tracking
export const RECONCILIATION_LAST_RUN_KEY = 'reconciliation:last_run';
export const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// 🔥 FIX 6: Monitoring persistence to Redis
export const METRICS_PREFIX = 'metrics:';
export const metricsKey = (metricName: string): string => `${METRICS_PREFIX}${metricName}`;
export const ERRORS_RECENT_KEY = 'errors:recent';
export const ERRORS_RECENT_TTL = 86400; // 24 hours
export const METRICS_PERSIST_INTERVAL_MS = 30 * 1000; // 30 seconds
export const METRICS_RETENTION_COUNT = 1000; // Keep last 1000 metrics per type

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
    logInfo('Invalidated creator dashboard cache', { userId });
  } catch (err) {
    logError('Failed to invalidate creator dashboard cache', err, { userId });
  }
};

// 🔥 SCALABILITY FIX: Creator tasks cache Redis key helpers
export const CREATOR_TASKS_PREFIX = 'creator:tasks:';
export const CREATOR_TASKS_TTL = 30; // 30 seconds cache (shorter than dashboard for more real-time updates)

export const creatorTasksKey = (userId: string): string =>
  `${CREATOR_TASKS_PREFIX}${userId}`;

/**
 * Invalidate creator tasks cache.
 * Called after billing settlement (when CallHistory is created) and task claim.
 */
export const invalidateCreatorTasks = async (userId: string): Promise<void> => {
  try {
    const redis = getRedis();
    await redis.del(creatorTasksKey(userId));
    logInfo('Invalidated creator tasks cache', { userId });
  } catch (err) {
    logError('Failed to invalidate creator tasks cache', err, { userId });
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
    logInfo('Invalidated admin caches', {
      sections: sections.length > 0 ? sections : ['all'],
      keysCount: keys.length,
    });
  } catch (err) {
    logError('Failed to invalidate admin caches', err, { sections });
  }
};
