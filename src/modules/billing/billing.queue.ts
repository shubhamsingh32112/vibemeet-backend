/**
 * Optional BullMQ driver for video-call billing (horizontal scaling without ZSET batch lock).
 * Enable with BILLING_DRIVER=bullmq
 */

import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { BILLING_PROCESS_INTERVAL_MS } from './billing.constants';
import { getIO } from '../../config/socket';
import { billingService } from './billing.service';
import { logError, logInfo, logWarning } from '../../utils/logger';
import { recordBillingMetric } from '../../utils/monitoring';
import { getRedis, callSessionKey, isRedisConfigured } from '../../config/redis';
import { isBullmqBillingEnabled } from './billing-driver';
import { updateBackpressureStage } from './billing-backpressure';
import { featureFlags } from '../../config/feature-flags';

export { isBullmqBillingEnabled };

const QUEUE_NAME = 'billing-cycle';
const BILLING_CYCLE_HEARTBEAT_PREFIX = 'billing:cycle:heartbeat:';
const BILLING_CYCLE_HEARTBEAT_TTL_SECONDS = Math.min(
  600,
  Math.max(30, parseInt(process.env.BILLING_CYCLE_HEARTBEAT_TTL_SECONDS || '120', 10) || 120)
);

let sharedConnection: Redis | null = null;
let billingQueue: Queue | null = null;
let billingWorker: Worker | null = null;
let lastQueueStatsAt = 0;

function readBullmqConcurrency(): number {
  const fallback = parseInt(
    process.env.BILLING_BATCH_SIZE || process.env.BILLING_DEFAULT_BULLMQ_CONCURRENCY || '130',
    10
  );
  const raw = parseInt(process.env.BILLING_BULLMQ_CONCURRENCY || String(fallback), 10);
  if (!Number.isFinite(raw)) {
    return 130;
  }
  return Math.min(200, Math.max(1, raw));
}

function readBackpressureLagThresholdMs(): number {
  const raw = parseInt(process.env.BILLING_BACKPRESSURE_LAG_MS || '1500', 10);
  if (!Number.isFinite(raw) || raw < 0) {
    return 1500;
  }
  return Math.min(120_000, raw);
}

function readBackpressureDelayFactor(): number {
  const raw = parseFloat(process.env.BILLING_BACKPRESSURE_DELAY_FACTOR || '1.5');
  if (!Number.isFinite(raw) || raw < 1) {
    return 1.5;
  }
  return Math.min(5, raw);
}

function readBackpressureDelayCapMs(): number {
  const raw = parseInt(process.env.BILLING_BACKPRESSURE_DELAY_CAP_MS || '30000', 10);
  if (!Number.isFinite(raw)) {
    return 30000;
  }
  return Math.min(120_000, Math.max(BILLING_PROCESS_INTERVAL_MS, raw));
}

async function computeNextCycleDelayMs(
  queueLagMs: number,
  callId: string,
  baseMs: number
): Promise<number> {
  if (!featureFlags.billingAdaptiveLagPolicyEnabled) {
    return baseMs;
  }
  const thresholdMs = readBackpressureLagThresholdMs();
  if (queueLagMs <= thresholdMs) {
    return baseMs;
  }

  const factor = readBackpressureDelayFactor();
  const cap = readBackpressureDelayCapMs();
  const lagBoostSteps = Math.min(4, Math.floor(queueLagMs / thresholdMs));
  const adaptiveFactor = factor + lagBoostSteps * 0.2;
  const bumped = Math.min(Math.floor(baseMs * adaptiveFactor), cap);
  recordBillingMetric('billing_backpressure_applied', 1, { callId });
  if (bumped > baseMs) {
    recordBillingMetric('billing_cycle_delay_adaptive_ms', bumped, {
      callId,
      queueLagMs: String(queueLagMs),
      thresholdMs: String(thresholdMs),
    });
  }
  return bumped;
}

/**
 * Chain the next delayed billing job after a successful tick (worker, DLQ, stale recovery).
 * Use queueLagMsApprox=0 when lag is unknown (reconciliation paths).
 */
export async function scheduleNextBillingCycleAfterTickOk(
  callId: string,
  queueLagMsApprox: number
): Promise<void> {
  const delay = await computeNextCycleDelayMs(
    queueLagMsApprox,
    callId,
    BILLING_PROCESS_INTERVAL_MS
  );
  await scheduleBillingJob(callId, delay);
}

export function billingCycleJobId(callId: string): string {
  return `billing:${callId}`;
}

async function touchBillingCycleHeartbeat(callId: string): Promise<void> {
  await getRedis()
    .setex(
      `${BILLING_CYCLE_HEARTBEAT_PREFIX}${callId}`,
      BILLING_CYCLE_HEARTBEAT_TTL_SECONDS,
      String(Date.now())
    )
    .catch(() => {});
}

/**
 * True when no healthy delayed/waiting/active cycle job exists for this call (e.g. lost after crash).
 */
export async function needsBillingCycleReschedule(callId: string): Promise<boolean> {
  const q = getQueue();
  const job = await q.getJob(billingCycleJobId(callId));
  if (!job) {
    recordBillingMetric('billing_cycle_missing_recreated', 1, { callId });
    return true;
  }
  const state = await job.getState();
  const isHealthyState = state === 'delayed' || state === 'waiting' || state === 'active';
  if (isHealthyState) {
    recordBillingMetric('billing_cycle_exists_healthy', 1, { callId, state });
    if (state === 'delayed') {
      const delay = Number(job.delay || 0);
      if (delay > BILLING_PROCESS_INTERVAL_MS * 5) {
        recordBillingMetric('billing_cycle_exists_but_stale', 1, {
          callId,
          state,
          delayMs: String(delay),
        });
      }
    }
    return false;
  }
  recordBillingMetric('billing_cycle_exists_but_stale', 1, { callId, state });
  return true;
}

function createRedisConnection(): Redis {
  const url = process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL;
  if (url) {
    return new Redis(url, { maxRetriesPerRequest: null });
  }
  const host = process.env.REDISHOST;
  if (!host) {
    throw new Error('BILLING_DRIVER=bullmq requires REDIS_URL or REDISHOST');
  }
  const port = parseInt(process.env.REDISPORT || '6379', 10);
  const password = process.env.REDIS_PASSWORD || process.env.REDISPASSWORD;
  const username = process.env.REDISUSER;
  return new Redis({
    host,
    port,
    password,
    username,
    maxRetriesPerRequest: null,
  });
}

function getSharedConnection(): Redis {
  if (!sharedConnection) {
    sharedConnection = createRedisConnection();
  }
  return sharedConnection;
}

function getQueue(): Queue {
  if (!billingQueue) {
    billingQueue = new Queue(QUEUE_NAME, {
      connection: getSharedConnection().duplicate(),
    });
  }
  return billingQueue;
}

function assertBullmqRuntimeSafety(): void {
  if (!isBullmqBillingEnabled()) return;
  if (!isRedisConfigured()) {
    throw new Error('BILLING_DRIVER=bullmq requires Redis configuration');
  }
}

/**
 * Schedule the next billing cycle for a call (chain of delayed jobs).
 * Relies on per-call `billing:cycle_lock:` + idempotent ticks in `processBillingTick` (MAX_BILLING_DELTA_MS).
 * Default: single `add` with stable jobId (no get/remove race). Set `BILLING_CYCLE_EMERGENCY_REMOVE_DEDUPE=true`
 * to restore the previous remove-before-add behavior if needed.
 */
export async function scheduleBillingJob(
  callId: string,
  delayMs: number = BILLING_PROCESS_INTERVAL_MS
): Promise<void> {
  assertBullmqRuntimeSafety();
  const q = getQueue();
  const jobId = billingCycleJobId(callId);
  recordBillingMetric('bullmq_cycle_enqueue_attempted', 1, { callId });

  if (process.env.BILLING_CYCLE_EMERGENCY_REMOVE_DEDUPE === 'true') {
    const existing = await q.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'active') {
        recordBillingMetric('bullmq_cycle_enqueue_deduped', 1, { callId, state });
        return;
      }
      if (state === 'waiting' || state === 'delayed') {
        await existing.remove().catch(() => {});
        recordBillingMetric('bullmq_cycle_enqueue_deduped', 1, { callId, state });
      }
    }
  }

  try {
    await q.add(
      'cycle',
      { callId },
      {
        jobId,
        delay: delayMs,
        removeOnComplete: false,
        removeOnFail: false,
      }
    );
    await touchBillingCycleHeartbeat(callId);
  } catch (err) {
    recordBillingMetric('bullmq_cycle_enqueue_failed', 1, { callId });
    logError('BullMQ cycle add failed', err, { callId, jobId });
    throw err;
  }

  const now = Date.now();
  if (now - lastQueueStatsAt >= 5000) {
    lastQueueStatsAt = now;
    try {
      const counts = await q.getJobCounts('active', 'waiting', 'delayed');
      const activeCount = Number(counts.active || 0);
      const waitingCount = Number(counts.waiting || 0);
      const delayedCount = Number(counts.delayed || 0);
      recordBillingMetric('bullmq_cycle_jobs_active', activeCount, {});
      recordBillingMetric('bullmq_cycle_jobs_waiting', waitingCount, {});
      recordBillingMetric('bullmq_cycle_jobs_delayed', delayedCount, {});
    } catch (error) {
      logError('Failed to collect BullMQ queue counts', error, {});
    }
  }
}

export async function cancelBillingCycleJob(callId: string): Promise<void> {
  assertBullmqRuntimeSafety();
  const q = getQueue();
  const job = await q.getJob(billingCycleJobId(callId));
  if (!job) return;
  await job.remove().catch(() => {});
  recordBillingMetric('bullmq_cycle_cancelled', 1, { callId });
}

export function startBillingBullWorker(): Worker {
  assertBullmqRuntimeSafety();
  if (billingWorker) {
    logWarning('Billing BullMQ worker already running', {});
    return billingWorker;
  }

  logInfo('Starting BullMQ billing worker', { queue: QUEUE_NAME });

  billingWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { callId } = job.data as { callId: string };
      const io = getIO();
      const queueLagMs = Math.max(0, Date.now() - (job.timestamp + (job.opts.delay || 0)));
      recordBillingMetric('bullmq_queue_lag_ms', queueLagMs, { callId });
      await touchBillingCycleHeartbeat(callId);
      updateBackpressureStage({ queueLagMs });
      let result: Awaited<ReturnType<typeof billingService.processBillingTick>>;
      try {
        result = await billingService.processBillingTick(io, callId);
      } catch (err) {
        logError('BullMQ billing job threw', err, { callId });
        try {
          const redis = getRedis();
          const exists = await redis.exists(callSessionKey(callId));
          if (exists === 1) {
            const base = BILLING_PROCESS_INTERVAL_MS * 2;
            const delay = await computeNextCycleDelayMs(queueLagMs, callId, base);
            await scheduleBillingJob(callId, delay);
          }
        } catch (rescheduleErr) {
          logError('BullMQ reschedule after throw failed', rescheduleErr, { callId });
        }
        recordBillingMetric('bullmq_tick_rescheduled', 1, { callId });
        return 'retry_scheduled';
      }

      if (result === 'tick_ok') {
        await touchBillingCycleHeartbeat(callId);
        await scheduleNextBillingCycleAfterTickOk(callId, queueLagMs).catch((e) =>
          logError('BullMQ schedule next failed', e, { callId })
        );
      } else if (result === 'stop_needs_settlement') {
        const { finalizeCallSession } = await import('./billing-session-finalization.service');
        await finalizeCallSession(io, {
          callId,
          reason: 'insufficient_coins',
          source: 'billing_tick',
        }).catch((e) => logError('finalizeCallSession failed', e, { callId }));
      }
      return result;
    },
    {
      connection: getSharedConnection().duplicate(),
      concurrency: readBullmqConcurrency(),
    }
  );

  logInfo('BullMQ billing worker config', {
    queue: QUEUE_NAME,
    concurrency: readBullmqConcurrency(),
    adaptiveLagPolicyEnabled: featureFlags.billingAdaptiveLagPolicyEnabled,
  });

  billingWorker.on('failed', (job, err) => {
    logError('BullMQ billing job failed', err, { jobId: job?.id, callId: job?.data?.callId });
  });

  return billingWorker;
}

export async function closeBillingBullMq(): Promise<void> {
  await billingWorker?.close();
  await billingQueue?.close();
  if (sharedConnection) {
    await sharedConnection.quit();
  }
  billingWorker = null;
  billingQueue = null;
  sharedConnection = null;
}
