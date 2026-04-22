import { Server } from 'socket.io';
import {
  getRedis,
  callSessionKey,
  ACTIVE_BILLING_CALLS_KEY,
} from '../../config/redis';
import { recordBillingMetric } from '../../utils/monitoring';
import { billingService } from './billing.service';
import { settleCall } from './billing-settlement.service';
import { logError, logWarning, logInfo, logDebug } from '../../utils/logger';
import {
  isBullmqBillingEnabled,
  startBillingBullWorker,
} from './billing.queue';
import { BILLING_PROCESS_INTERVAL_MS } from './billing.constants';
import { updateBackpressureStage } from './billing-backpressure';
import { getLatestEventLoopLagMs } from '../../utils/runtime-signals';
import { featureFlags } from '../../config/feature-flags';

let globalBillingProcessor: NodeJS.Timeout | null = null;

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

const BILLING_BATCH_SIZE = readIntEnv('BILLING_BATCH_SIZE', 130, 50, 300);
const BILLING_LAG_ADAPTIVE_THRESHOLD_MS = readIntEnv(
  'BILLING_LAG_ADAPTIVE_THRESHOLD_MS',
  1500,
  100,
  120_000
);
const BILLING_LAG_ADAPTIVE_BOOST_MULTIPLIER = readIntEnv(
  'BILLING_LAG_ADAPTIVE_BOOST_MULTIPLIER',
  2,
  1,
  5
);
const BILLING_LAG_ADAPTIVE_MAX_BATCH = readIntEnv('BILLING_LAG_ADAPTIVE_MAX_BATCH', 260, 50, 500);
const BILLING_LAG_SKIP_THRESHOLD_MS = readIntEnv(
  'BILLING_LAG_SKIP_THRESHOLD_MS',
  8000,
  500,
  240_000
);
const BILLING_EVENT_LOOP_SKIP_THRESHOLD_MS = readIntEnv(
  'BILLING_EVENT_LOOP_SKIP_THRESHOLD_MS',
  120,
  20,
  5000
);

/**
 * Single global billing processor that processes all active calls in batches.
 * Multi-instance safe: each call is processed under a short per-call Redis lock
 * inside BillingService.
 */
export async function processBillingBatch(io: Server): Promise<void> {
  if (isBullmqBillingEnabled()) {
    return;
  }

  let redis;
  try {
    redis = getRedis();
  } catch (err) {
    logError('Failed to get Redis client for batch processor', err);
    recordBillingMetric('batch_processor_redis_error', 1, {});
    return;
  }

  const now = Date.now();

  try {
    const firstDue = await redis.zrangebyscore(
      ACTIVE_BILLING_CALLS_KEY,
      0,
      now,
      'LIMIT',
      0,
      1
    );
    const firstDueCallId = Array.isArray(firstDue) && firstDue.length > 0 ? String(firstDue[0]) : null;
    const firstDueScore = firstDueCallId
      ? Number(await redis.zscore(ACTIVE_BILLING_CALLS_KEY, firstDueCallId) || now)
      : now;
    const queueLagMsApprox = firstDueCallId ? Math.max(0, now - firstDueScore) : 0;

    if (queueLagMsApprox > 0) {
      recordBillingMetric('zset_queue_lag_ms', queueLagMsApprox, {});
      updateBackpressureStage({ queueLagMs: queueLagMsApprox });
    }

    const eventLoopLagMs = getLatestEventLoopLagMs();
    const shouldSkipThisCycle =
      featureFlags.billingAdaptiveLagPolicyEnabled &&
      queueLagMsApprox >= BILLING_LAG_SKIP_THRESHOLD_MS &&
      eventLoopLagMs >= BILLING_EVENT_LOOP_SKIP_THRESHOLD_MS;
    if (shouldSkipThisCycle) {
      recordBillingMetric('zset_cycle_skipped_lag_guard', 1, {
        queueLagMs: String(queueLagMsApprox),
        eventLoopLagMs: String(Math.round(eventLoopLagMs)),
      });
      return;
    }

    const effectiveBatchSize =
      featureFlags.billingAdaptiveLagPolicyEnabled && queueLagMsApprox > BILLING_LAG_ADAPTIVE_THRESHOLD_MS
        ? Math.min(
            BILLING_LAG_ADAPTIVE_MAX_BATCH,
            Math.max(BILLING_BATCH_SIZE, Math.floor(BILLING_BATCH_SIZE * BILLING_LAG_ADAPTIVE_BOOST_MULTIPLIER))
          )
        : BILLING_BATCH_SIZE;
    if (effectiveBatchSize > BILLING_BATCH_SIZE) {
      recordBillingMetric('zset_adaptive_batch_boost_applied', 1, {
        batchSize: String(effectiveBatchSize),
        queueLagMs: String(queueLagMsApprox),
      });
    }

    const callsDue = await redis.zrangebyscore(
      ACTIVE_BILLING_CALLS_KEY,
      0,
      now,
      'LIMIT',
      0,
      effectiveBatchSize
    );

    const callIds: string[] = Array.isArray(callsDue) ? callsDue : [];

    if (callIds.length === 0) {
      return;
    }

    logDebug('Processing billing batch', { count: callIds.length });

    const processingPromises = callIds.map(async (callId: string) => {
      try {
        const tickResult = await billingService.processBillingTick(io, callId);

        if (tickResult === 'tick_ok') {
          const sessionRaw = await redis.get(callSessionKey(callId));
          let nextBillingTime = now + BILLING_PROCESS_INTERVAL_MS;
          if (sessionRaw) {
            try {
              const sess = JSON.parse(sessionRaw as string) as {
                lastProcessedAt?: number;
              };
              const lp = Number(sess.lastProcessedAt) || now;
              nextBillingTime = lp + BILLING_PROCESS_INTERVAL_MS;
            } catch {
              nextBillingTime = now + BILLING_PROCESS_INTERVAL_MS;
            }
          }
          await redis.zadd(ACTIVE_BILLING_CALLS_KEY, nextBillingTime, callId);
        } else {
          await redis.zrem(ACTIVE_BILLING_CALLS_KEY, callId);
          logDebug('Removed call from active billing', { callId, tickResult });
          if (tickResult === 'stop_needs_settlement') {
            await settleCall(io, callId).catch((settleErr) =>
              logError('settleCall after billing tick stop', settleErr, { callId })
            );
          }
        }
      } catch (err) {
        logError('Error processing billing tick in batch', err, { callId });
      }
    });

    await Promise.all(processingPromises);

    recordBillingMetric('batch_processed', callIds.length, {
      batchSize: callIds.length.toString(),
    });
  } catch (err) {
    logError('Error in billing batch processor', err);
  }
}

export function startGlobalBillingProcessor(io: Server): void {
  if (isBullmqBillingEnabled()) {
    startBillingBullWorker();
    return;
  }

  if (globalBillingProcessor) {
    logWarning('Global billing processor already running', {});
    return;
  }

  logInfo('Starting global billing batch processor', {
    interval: BILLING_PROCESS_INTERVAL_MS,
    batchSize: BILLING_BATCH_SIZE,
    adaptiveLagPolicyEnabled: featureFlags.billingAdaptiveLagPolicyEnabled,
  });

  processBillingBatch(io).catch((err) => {
    logError('Error in initial billing batch', err);
  });

  globalBillingProcessor = setInterval(() => {
    processBillingBatch(io).catch((err) => {
      logError('Error in scheduled billing batch', err);
    });
  }, BILLING_PROCESS_INTERVAL_MS);
}

export function stopGlobalBillingProcessor(): void {
  if (globalBillingProcessor) {
    clearInterval(globalBillingProcessor);
    globalBillingProcessor = null;
    logInfo('Stopped global billing batch processor', {});
  }
}
