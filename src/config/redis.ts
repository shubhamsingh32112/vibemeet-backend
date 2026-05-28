import Redis from 'ioredis';
import { bumpRedisClose, bumpRedisError } from '../utils/driver-metrics';
import { logInfo, logError, logWarning } from '../utils/logger';

let redis: Redis | null = null;
export type RedisEndpointMode = 'internal' | 'public' | 'host-mode' | 'unknown';

/** 0 = IPv4+IPv6 (A/AAAA), 4 = IPv4, 6 = IPv6. Use REDIS_FAMILY=0 if Railway DNS is flaky. */
function getRedisFamily(): number | undefined {
  const raw = process.env.REDIS_FAMILY;
  if (raw === undefined || raw === '') return undefined;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

function redactRedisUrl(url: string): string {
  return url.replace(/:[^:@]+@/, ':****@');
}

function classifyRedisUrl(url: string): RedisEndpointMode {
  const normalized = String(url || '').toLowerCase();
  if (normalized.includes('.railway.internal') || normalized.includes('@redis:')) {
    return 'internal';
  }
  if (normalized.startsWith('rediss://') || normalized.includes('proxy.rlwy.net')) {
    return 'public';
  }
  return 'unknown';
}

export function getRedisEndpointMode(): RedisEndpointMode {
  if (process.env.REDIS_URL) {
    return classifyRedisUrl(process.env.REDIS_URL);
  }
  if (process.env.REDIS_PUBLIC_URL) {
    return classifyRedisUrl(process.env.REDIS_PUBLIC_URL);
  }
  if (process.env.REDISHOST) {
    return 'host-mode';
  }
  return 'unknown';
}

export const getRedis = (): Redis => {
  if (!redis) {
    // Railway Redis connection - supports both REDIS_URL and individual variables
    const redisUrl = process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL;
    const family = getRedisFamily();

    if (!redisUrl && !process.env.REDISHOST) {
      const error = new Error(
        'CRITICAL: Redis not configured. Billing will not work.\n' +
        'Required: REDIS_URL, REDIS_PUBLIC_URL, or REDISHOST environment variable.\n' +
        'Railway Redis: Add Redis service and configure environment variables.'
      );
      logError('Redis configuration missing', error, { alert: true });
      throw error;
    }
    
    if (process.env.REDIS_URL && process.env.REDIS_PUBLIC_URL) {
      logWarning('Both REDIS_URL and REDIS_PUBLIC_URL are set; REDIS_URL takes precedence', {
        selectedMode: classifyRedisUrl(process.env.REDIS_URL),
      });
    }

    if (redisUrl) {
      const endpointMode = classifyRedisUrl(redisUrl);
      // Use connection URL if provided
      redis = new Redis(redisUrl, {
        ...(family !== undefined ? { family } : {}),
        retryStrategy: (times) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        connectTimeout: 10000,
      });
      logInfo('Railway Redis client initialized from URL', {
        endpointMode,
        url: redactRedisUrl(redisUrl),
      });
    } else {
      // Fall back to individual connection parameters
      const host = process.env.REDISHOST;
      const port = parseInt(process.env.REDISPORT || '6379', 10);
      const password = process.env.REDIS_PASSWORD || process.env.REDISPASSWORD;
      const username = process.env.REDISUSER;

      redis = new Redis({
        host,
        port,
        password,
        username,
        ...(family !== undefined ? { family } : {}),
        retryStrategy: (times) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        connectTimeout: 10000,
      });
      logInfo('Railway Redis client initialized from individual parameters', {
        endpointMode: 'host-mode',
        host,
        port,
        username: username || 'default',
      });
    }
    
    // 🔥 FIX: Add event listeners for connection monitoring
    redis.on('connect', () => {
      logInfo('Redis connected successfully');
    });
    
    redis.on('ready', () => {
      logInfo('Redis ready to accept commands');
    });
    
    redis.on('error', (err) => {
      bumpRedisError();
      logError('CRITICAL: Redis connection error', err, {
        alert: true,
        impact: 'Billing operations will fail',
      });
    });
    
    redis.on('close', () => {
      bumpRedisClose();
      logWarning('Redis connection closed', {
        alert: true,
        impact: 'Billing operations will fail',
      });
    });
    
    redis.on('reconnecting', (delay: number) => {
      logWarning('Redis reconnecting', { delay });
    });
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
export const CREATOR_PRESENCE_KEY_PREFIX = 'creator:presence:';

export const availabilityKey = (firebaseUid: string): string =>
  `${AVAILABILITY_KEY_PREFIX}${firebaseUid}`;

export const creatorPresenceKey = (firebaseUid: string): string =>
  `${CREATOR_PRESENCE_KEY_PREFIX}${firebaseUid}`;

/** Epoch ms when creator Redis presence last flipped busy → online (for daily online-time stats). */
export const creatorAvailOnlineSinceKey = (firebaseUid: string): string =>
  `creator:avail_online_since:${firebaseUid}`;

// Call billing Redis key helpers
export const CALL_SESSION_PREFIX = 'call:session:';
export const CALL_USER_COINS_PREFIX = 'call:user_coins:';
export const CALL_USER_INTRO_MICROS_PREFIX = 'call:user_intro_micros:';
export const CALL_USER_WALLET_MICROS_PREFIX = 'call:user_wallet_micros:';
export const CALL_CREATOR_EARNINGS_PREFIX = 'call:creator_earnings:';

export const callSessionKey = (callId: string): string =>
  `${CALL_SESSION_PREFIX}${callId}`;

/** @deprecated Legacy merged balance; prefer callUserIntroMicrosKey + callUserWalletMicrosKey. */
export const callUserCoinsKey = (callId: string): string =>
  `${CALL_USER_COINS_PREFIX}${callId}`;

export const callUserIntroMicrosKey = (callId: string): string =>
  `${CALL_USER_INTRO_MICROS_PREFIX}${callId}`;

export const callUserWalletMicrosKey = (callId: string): string =>
  `${CALL_USER_WALLET_MICROS_PREFIX}${callId}`;

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

// Settlement orchestration (finalizeCallSession)
export const SETTLEMENT_CLAIM_PREFIX = 'settlement:claim:';
export const settlementClaimKey = (callId: string): string =>
  `${SETTLEMENT_CLAIM_PREFIX}${callId}`;
export const SETTLEMENT_CLAIM_TTL_SECONDS = Math.min(
  600,
  Math.max(60, parseInt(process.env.BILLING_SETTLEMENT_CLAIM_TTL_SECONDS || '180', 10) || 180)
);

export const BILLING_SETTLEMENT_RETRY_KEY = 'billing:settlement-retry';
export const BILLING_SETTLEMENT_RETRY_PAYLOAD_PREFIX = 'billing:settlement-retry:payload:';
export const BILLING_SETTLEMENT_RETRY_DEDUP_PREFIX = 'billing:settlement-retry:dedup:';
export const billingSettlementRetryPayloadKey = (callId: string): string =>
  `${BILLING_SETTLEMENT_RETRY_PAYLOAD_PREFIX}${callId}`;
export const billingSettlementRetryDedupKey = (callId: string): string =>
  `${BILLING_SETTLEMENT_RETRY_DEDUP_PREFIX}${callId}`;

export const FINALIZE_INFLIGHT_PREFIX = 'billing:finalize:inflight:';
export const finalizeInflightKey = (callId: string): string =>
  `${FINALIZE_INFLIGHT_PREFIX}${callId}`;

export const BILLING_WATCHDOG_COOLDOWN_PREFIX = 'billing:watchdog:recovering:cooldown:';
export const BILLING_WATCHDOG_ATTEMPTS_PREFIX = 'billing:watchdog:recovering:attempts:';
export const BILLING_RECOVERY_DEADLETTER_PREFIX = 'billing:recovery:deadletter:';
export const billingWatchdogCooldownKey = (callId: string): string =>
  `${BILLING_WATCHDOG_COOLDOWN_PREFIX}${callId}`;
export const billingWatchdogAttemptsKey = (callId: string): string =>
  `${BILLING_WATCHDOG_ATTEMPTS_PREFIX}${callId}`;
export const billingRecoveryDeadLetterKey = (callId: string): string =>
  `${BILLING_RECOVERY_DEADLETTER_PREFIX}${callId}`;

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

// DLQ SSCAN cursor (fairness across large dead-letter sets)
export const BILLING_DLQ_SSCAN_CURSOR_KEY = 'billing:dlq:sscan_cursor';

// Reconciliation job tracking
export const RECONCILIATION_LAST_RUN_KEY = 'reconciliation:last_run';
export const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const BILLING_RECONCILIATION_LOCK_KEY = 'lock:reconciliation:billing';
export const CALL_RECONCILIATION_LOCK_KEY = 'lock:reconciliation:call';
export const RECONCILIATION_LOCK_TTL_MS = Math.min(
  120_000,
  Math.max(10_000, parseInt(process.env.RECONCILIATION_LOCK_TTL_MS || '90000', 10) || 90_000)
);

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

// ── Creator public catalog / detail caches (feed, uids, by-id) ───────────
export const CREATOR_FEED_PREFIX = 'creator:feed:';
export const CREATOR_FEED_INDEX_KEY = 'creator:feed:index';
export const CREATOR_FEED_TTL = 30;

export const CREATOR_UIDS_CACHE_KEY = 'creator:uids:v1';
export const CREATOR_UIDS_TTL = 60;

export const CREATOR_DETAIL_PREFIX = 'creator:detail:';
export const CREATOR_DETAIL_INDEX_KEY = 'creator:detail:index';
export const CREATOR_DETAIL_TTL = 60;

export const CREATOR_FEED_HIT_KEY = 'creator:feed:metrics:hits';
export const CREATOR_FEED_MISS_KEY = 'creator:feed:metrics:misses';

export const creatorFeedCacheKey = (page: number, limit: number): string =>
  `${CREATOR_FEED_PREFIX}p${page}:l${limit}`;

export const creatorDetailCacheKey = (creatorId: string): string =>
  `${CREATOR_DETAIL_PREFIX}${creatorId}`;

export async function registerCreatorFeedCacheKey(key: string): Promise<void> {
  if (!isRedisConfigured()) return;
  try {
    const redis = getRedis();
    await redis.sadd(CREATOR_FEED_INDEX_KEY, key);
  } catch (err) {
    logError('Failed to register creator feed cache key', err, { key });
  }
}

export async function registerCreatorDetailCacheKey(key: string): Promise<void> {
  if (!isRedisConfigured()) return;
  try {
    const redis = getRedis();
    await redis.sadd(CREATOR_DETAIL_INDEX_KEY, key);
  } catch (err) {
    logError('Failed to register creator detail cache key', err, { key });
  }
}

export async function invalidateCreatorFeedCaches(): Promise<void> {
  if (!isRedisConfigured()) return;
  try {
    const redis = getRedis();
    const keys = await redis.smembers(CREATOR_FEED_INDEX_KEY);
    if (keys.length > 0) {
      await redis.del(...keys, CREATOR_FEED_INDEX_KEY);
    } else {
      await redis.del(CREATOR_FEED_INDEX_KEY);
    }
    logInfo('Invalidated creator feed caches', { keysRemoved: keys.length });
  } catch (err) {
    logError('Failed to invalidate creator feed caches', err);
  }
}

export async function invalidateCreatorUidsCache(): Promise<void> {
  if (!isRedisConfigured()) return;
  try {
    const redis = getRedis();
    await redis.del(CREATOR_UIDS_CACHE_KEY);
    logInfo('Invalidated creator UIDs cache');
  } catch (err) {
    logError('Failed to invalidate creator UIDs cache', err);
  }
}

export async function invalidateCreatorDetailCache(creatorId: string): Promise<void> {
  if (!isRedisConfigured()) return;
  try {
    const redis = getRedis();
    const k = creatorDetailCacheKey(creatorId);
    await redis.del(k);
    await redis.srem(CREATOR_DETAIL_INDEX_KEY, k);
    logInfo('Invalidated creator detail cache', { creatorId });
  } catch (err) {
    logError('Failed to invalidate creator detail cache', err, { creatorId });
  }
}

/** Clears paginated feed + presence UID list (call when catalog membership or list-facing fields change). */
export async function invalidateCreatorCatalogCaches(): Promise<void> {
  await Promise.all([invalidateCreatorFeedCaches(), invalidateCreatorUidsCache()]);
}

export async function bumpCreatorFeedCacheMetric(kind: 'hit' | 'miss'): Promise<void> {
  if (!isRedisConfigured()) return;
  try {
    const redis = getRedis();
    await redis.incr(kind === 'hit' ? CREATOR_FEED_HIT_KEY : CREATOR_FEED_MISS_KEY);
  } catch {
    // best-effort metrics
  }
}
