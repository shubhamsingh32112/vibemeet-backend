import { performance } from 'perf_hooks';
import { initializeFirebase } from '../config/firebase';
import { connectDatabase } from '../config/database';
import { configureStreamPush } from '../config/stream';
import { isRedisConfigured } from '../config/redis';
import { isRazorpayConfigured } from '../config/razorpay';
import { validatePricingConfig } from '../config/pricing.config';
import { isBullmqBillingEnabled } from '../modules/billing/billing.queue';
import { cleanupStaleCreatorLocks } from '../modules/video/video.webhook';
import { CreatorTaskProgress } from '../modules/creator/creator-task.model';
import { logInfo, logWarning, logError } from '../utils/logger';
import { logRateLimitConfig } from '../utils/rate-limit.service';
import { recordSystemMetric } from '../utils/monitoring';
import { setLatestEventLoopLagMs } from '../utils/runtime-signals';
import { getServiceRole } from '../config/service-role';

let eventLoopProbe: NodeJS.Timeout | null = null;

export function getEventLoopProbe(): NodeJS.Timeout | null {
  return eventLoopProbe;
}

export function clearEventLoopProbe(): void {
  if (eventLoopProbe) {
    clearInterval(eventLoopProbe);
    eventLoopProbe = null;
  }
}

function assertProductionSecurity(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const jwt = (process.env.JWT_SECRET || '').trim();
  if (!jwt || jwt === 'admin-secret-change-me') {
    throw new Error(
      'NODE_ENV=production requires JWT_SECRET to be set to a secure non-default value',
    );
  }
  const email = (process.env.ADMIN_EMAIL || '').trim();
  const pw = (process.env.ADMIN_PASSWORD || '').trim();
  if (!email || !pw) {
    throw new Error('NODE_ENV=production requires ADMIN_EMAIL and ADMIN_PASSWORD to be set');
  }
}

function warnIfMissingPublicUrls(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const apiBase =
    (process.env.PUBLIC_API_BASE_URL || process.env.API_BASE_URL || process.env.BACKEND_PUBLIC_URL || '').trim();
  const webBase = (process.env.WEB_CHECKOUT_BASE_URL || '').trim();
  if (!apiBase) {
    logWarning('PUBLIC_API_BASE_URL is not set in production; checkout links may embed the wrong apiBase', {});
  }
  if (!webBase) {
    logWarning('WEB_CHECKOUT_BASE_URL is not set in production; /payment/web/initiate may generate broken checkoutUrl', {});
  }
}

function assertProductionRedis(): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (!isRedisConfigured()) {
    throw new Error(
      'NODE_ENV=production requires Redis. Add variable references: REDIS_URL (private) or REDISHOST, REDISPORT, REDIS_PASSWORD, REDISUSER from your Railway Redis service.',
    );
  }
}

function enforceProductionBillingDriverSafety(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const isRailway = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_PROJECT_ID;
  const bullmq = isBullmqBillingEnabled();
  if (bullmq) {
    logInfo('Production billing driver safety check passed', { billingDriver: 'bullmq' });
    return;
  }
  const allowUnsafe = process.env.BILLING_ALLOW_UNSAFE_ZSET_IN_PRODUCTION === 'true';
  if (!isRailway) {
    logWarning('Production is running billing driver without BullMQ', {
      billingDriver: process.env.BILLING_DRIVER || 'zset',
    });
    return;
  }
  if (allowUnsafe) {
    logWarning('Unsafe Railway billing driver override is enabled', {
      billingDriver: process.env.BILLING_DRIVER || 'zset',
      env: 'BILLING_ALLOW_UNSAFE_ZSET_IN_PRODUCTION=true',
    });
    return;
  }
  throw new Error(
    'Unsafe Railway billing configuration: set BILLING_DRIVER=bullmq for production replicas, or explicitly override with BILLING_ALLOW_UNSAFE_ZSET_IN_PRODUCTION=true.',
  );
}

async function runCreatorTaskProgressIndexMigration(): Promise<void> {
  try {
    const collection = CreatorTaskProgress.collection;
    const indexes = await collection.indexes();
    const oldIndex = indexes.find(
      (idx: { key?: Record<string, unknown>; unique?: boolean; name?: string }) =>
        idx.key?.creatorUserId === 1 &&
        idx.key?.taskKey === 1 &&
        !idx.key?.periodStart &&
        idx.unique === true,
    );
    if (oldIndex) {
      logInfo('Dropping old CreatorTaskProgress unique index (no periodStart)', {
        indexName: oldIndex.name,
        collection: 'CreatorTaskProgress',
      });
      await collection.dropIndex(oldIndex.name!);
      logInfo('Old index dropped. New index will be created by Mongoose', {
        indexName: oldIndex.name,
      });
    }
  } catch (migrationErr) {
    logInfo('CreatorTaskProgress index check', {
      error: (migrationErr as Error).message,
    });
  }
}

export async function verifyRedisOnStartup(): Promise<void> {
  if (!isRedisConfigured()) {
    logError('CRITICAL: Redis not configured', {
      alert: true,
      impact: 'Billing will not work - coins will not be deducted, creators will not earn',
      requiredEnvVars: ['REDIS_URL', 'REDIS_PUBLIC_URL', 'REDISHOST'],
    });
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Redis is required in production (assertProductionRedis should have failed)');
    }
    return;
  }

  try {
    const { getRedis } = await import('../config/redis');
    const redis = getRedis();
    await redis.ping();
    logInfo('Redis connected successfully', { serviceRole: getServiceRole() });

    const testKey = `healthcheck:startup:${Date.now()}`;
    await redis.setex(testKey, 10, 'test');
    const value = await redis.get(testKey);
    await redis.del(testKey);

    if (value !== 'test') {
      logError('CRITICAL: Redis write/read test failed', new Error('Read value mismatch'), {
        alert: true,
        impact: 'Billing will not work correctly',
      });
    } else {
      logInfo('Redis health check passed');
    }
  } catch (err) {
    logError('CRITICAL: Redis connection failed', err, {
      alert: true,
      impact: 'Billing will not work - coins will not be deducted, creators will not earn',
      requiredEnvVars: ['REDIS_URL', 'REDIS_PUBLIC_URL', 'REDISHOST'],
    });
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Redis connection required for production billing');
    }
  }
}

function logRazorpayStatus(): void {
  if (isRazorpayConfigured()) {
    logInfo('Payment gateway configured');
  } else {
    logWarning('Razorpay NOT configured - coin purchases will fail', {
      requiredEnvVars: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'],
    });
  }
}

export async function bootstrapCore(): Promise<void> {
  initializeFirebase();
  assertProductionSecurity();
  warnIfMissingPublicUrls();
  assertProductionRedis();
  enforceProductionBillingDriverSafety();
  validatePricingConfig();

  if (!eventLoopProbe) {
    eventLoopProbe = setInterval(() => {
      const startedAt = performance.now();
      setImmediate(() => {
        const lagMs = Math.max(0, performance.now() - startedAt);
        setLatestEventLoopLagMs(lagMs);
        recordSystemMetric('event_loop_lag_ms', lagMs);
      });
    }, 1000);
  }

  logRateLimitConfig();
  await connectDatabase();
  await cleanupStaleCreatorLocks();
  await runCreatorTaskProgressIndexMigration();
  await configureStreamPush();
  await verifyRedisOnStartup();
  logRazorpayStatus();
}
