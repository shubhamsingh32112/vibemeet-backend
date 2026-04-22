import { randomUUID } from 'crypto';
import { getRedis } from '../../config/redis';
import { logError, logInfo } from '../../utils/logger';
import { recordPaymentMetric } from '../../utils/monitoring';
import { retryFailedPaymentWebhooks } from './payment.controller';

const PAYMENT_WEBHOOK_RETRY_LOCK_KEY = 'lock:payment:webhook_retry';
const PAYMENT_WEBHOOK_RETRY_LOCK_TTL_MS = Math.max(
  5000,
  parseInt(process.env.PAYMENT_WEBHOOK_RETRY_LOCK_TTL_MS || '45000', 10) || 45000
);
const PAYMENT_WEBHOOK_RETRY_INTERVAL_MS = Math.max(
  5000,
  parseInt(process.env.PAYMENT_WEBHOOK_RETRY_INTERVAL_MS || '15000', 10) || 15000
);
const PAYMENT_WEBHOOK_RETRY_BATCH_SIZE = Math.max(
  1,
  parseInt(process.env.PAYMENT_WEBHOOK_RETRY_BATCH_SIZE || '20', 10) || 20
);

const RELEASE_LOCK_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

let retryTimer: NodeJS.Timeout | null = null;

async function releaseLock(lockKey: string, token: string): Promise<void> {
  const redis = getRedis();
  try {
    await redis.eval(RELEASE_LOCK_LUA, 1, lockKey, token);
  } catch {
    // ignore release failures
  }
}

async function runRetryPassWithLock(): Promise<void> {
  const redis = getRedis();
  const token = randomUUID();
  const lockResult = await redis.set(
    PAYMENT_WEBHOOK_RETRY_LOCK_KEY,
    token,
    'PX',
    PAYMENT_WEBHOOK_RETRY_LOCK_TTL_MS,
    'NX'
  );
  if (lockResult !== 'OK') {
    recordPaymentMetric('webhook.retry_lock_busy', 1);
    return;
  }

  const heartbeat = setInterval(() => {
    redis
      .set(
        PAYMENT_WEBHOOK_RETRY_LOCK_KEY,
        token,
        'PX',
        PAYMENT_WEBHOOK_RETRY_LOCK_TTL_MS,
        'XX'
      )
      .catch(() => {});
  }, Math.max(1000, Math.floor(PAYMENT_WEBHOOK_RETRY_LOCK_TTL_MS / 3)));

  try {
    const startedAt = Date.now();
    const processed = await retryFailedPaymentWebhooks(PAYMENT_WEBHOOK_RETRY_BATCH_SIZE);
    recordPaymentMetric('webhook.retry_tick_processed', processed);
    recordPaymentMetric('webhook.retry_tick_ms', Date.now() - startedAt);
  } catch (error) {
    recordPaymentMetric('webhook.retry_tick_failed', 1);
    logError('Payment webhook retry tick failed', error);
  } finally {
    clearInterval(heartbeat);
    await releaseLock(PAYMENT_WEBHOOK_RETRY_LOCK_KEY, token);
  }
}

export function startPaymentWebhookRetryWorker(): void {
  if (retryTimer) {
    logInfo('Payment webhook retry worker already running');
    return;
  }

  logInfo('Starting payment webhook retry worker', {
    intervalMs: PAYMENT_WEBHOOK_RETRY_INTERVAL_MS,
    batchSize: PAYMENT_WEBHOOK_RETRY_BATCH_SIZE,
  });

  runRetryPassWithLock().catch((error) => {
    logError('Initial payment webhook retry pass failed', error);
  });

  retryTimer = setInterval(() => {
    runRetryPassWithLock().catch((error) => {
      logError('Scheduled payment webhook retry pass failed', error);
    });
  }, PAYMENT_WEBHOOK_RETRY_INTERVAL_MS);
}

export function stopPaymentWebhookRetryWorker(): void {
  if (!retryTimer) return;
  clearInterval(retryTimer);
  retryTimer = null;
  logInfo('Stopped payment webhook retry worker');
}

