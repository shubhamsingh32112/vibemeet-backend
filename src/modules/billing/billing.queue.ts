/**
 * Optional BullMQ driver for video-call billing (horizontal scaling without ZSET batch lock).
 * Enable with BILLING_DRIVER=bullmq
 */

import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import {
  BILLING_PROCESS_INTERVAL_MS,
  getBillingChainHealStallMs,
  getBillingCycleLockDeferMs,
} from './billing.constants';
import { getIO } from '../../config/socket';
import { runsBillingWorkers } from '../../config/service-role';
import { billingService } from './billing.service';
import { logError, logInfo, logWarning } from '../../utils/logger';
import { recordBillingMetric } from '../../utils/monitoring';
import { getRedis, callSessionKey, isRedisConfigured } from '../../config/redis';
import { isBullmqBillingEnabled } from './billing-driver';
import { isLiveBillingLifecycle, updateBackpressureStage } from './billing-backpressure';
import { featureFlags } from '../../config/feature-flags';
import { logBillingHealth } from './billing-health-log';

export { isBullmqBillingEnabled };

const QUEUE_NAME = 'billing-cycle';
const BILLING_CYCLE_HEARTBEAT_PREFIX = 'billing:cycle:heartbeat:';
const BILLING_CYCLE_SCHEDULE_GATE_PREFIX = 'billing:cycle:scheduled:';
const BILLING_CYCLE_HEARTBEAT_TTL_SECONDS = Math.min(
  600,
  Math.max(30, parseInt(process.env.BILLING_CYCLE_HEARTBEAT_TTL_SECONDS || '120', 10) || 120)
);

let sharedConnection: Redis | null = null;
let billingQueue: Queue | null = null;
let billingWorker: Worker | null = null;
let lastQueueStatsAt = 0;

export function readBullmqConcurrency(): number {
  const fallback = parseInt(
    process.env.BILLING_BATCH_SIZE || process.env.BILLING_DEFAULT_BULLMQ_CONCURRENCY || '50',
    10
  );
  const raw = parseInt(process.env.BILLING_BULLMQ_CONCURRENCY || String(fallback), 10);
  if (!Number.isFinite(raw)) {
    return 50;
  }
  if (raw <= 0) {
    return 0;
  }
  return Math.min(200, Math.max(1, raw));
}

export async function getBillingQueueSnapshot(): Promise<{
  active: number;
  waiting: number;
  delayed: number;
  concurrency: number;
} | null> {
  if (!isBullmqBillingEnabled() || !isRedisConfigured()) {
    return null;
  }
  try {
    const q = getQueue();
    const counts = await q.getJobCounts('active', 'waiting', 'delayed');
    return {
      active: Number(counts.active || 0),
      waiting: Number(counts.waiting || 0),
      delayed: Number(counts.delayed || 0),
      concurrency: readBullmqConcurrency(),
    };
  } catch {
    return null;
  }
}

export function shouldStartBillingBullWorker(): boolean {
  if (!runsBillingWorkers()) {
    return false;
  }
  if (!isBullmqBillingEnabled()) {
    return false;
  }
  return readBullmqConcurrency() > 0;
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

function readCycleHealthWindowMs(): number {
  const fallback = Math.max(5000, BILLING_PROCESS_INTERVAL_MS * 6);
  const raw = parseInt(process.env.BILLING_CYCLE_HEALTH_WINDOW_MS || String(fallback), 10);
  if (!Number.isFinite(raw) || raw < 1000) {
    return fallback;
  }
  return Math.min(120_000, raw);
}

function readCycleQueueScanLimit(): number {
  const raw = parseInt(process.env.BILLING_CYCLE_QUEUE_SCAN_LIMIT || '500', 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 500;
  }
  return Math.min(5000, raw);
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

function normalizeBullmqJobIdComponent(value: string): string {
  return String(value || '').replace(/:/g, '__');
}

export function billingCycleJobId(callId: string): string {
  return `billing-${normalizeBullmqJobIdComponent(callId)}`;
}

function buildCycleInstanceJobId(callId: string): string {
  return `${billingCycleJobId(callId)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function billingCycleScheduleGateKey(callId: string): string {
  return `${BILLING_CYCLE_SCHEDULE_GATE_PREFIX}${callId}`;
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

async function hasHealthyQueuedCycleJob(
  q: Queue,
  callId: string
): Promise<{ healthy: boolean; state?: 'active' | 'waiting' | 'delayed'; delayMs?: number }> {
  const scanLimit = readCycleQueueScanLimit();
  for (const state of ['active', 'waiting', 'delayed'] as const) {
    const jobs = await q.getJobs([state], 0, scanLimit, true);
    const match = jobs.find((job) => (job.data as { callId?: string } | undefined)?.callId === callId);
    if (!match) {
      continue;
    }
    if (state === 'delayed') {
      return {
        healthy: true,
        state,
        delayMs: Math.max(0, Number(match.delay || 0)),
      };
    }
    return { healthy: true, state };
  }
  return { healthy: false };
}

async function isBillingSequenceStalled(callId: string): Promise<boolean> {
  const redis = getRedis();
  const sessionRaw = await redis.get(callSessionKey(callId));
  if (!sessionRaw) {
    return false;
  }
  try {
    const session = JSON.parse(sessionRaw) as {
      lifecycleState?: string;
      lastSequenceAdvanceAt?: number;
      lastHealthyTickAt?: number;
      startTime?: number;
    };
    const lifecycle = String(session.lifecycleState || 'ACTIVE');
    if (lifecycle !== 'ACTIVE' && lifecycle !== 'RECOVERING' && lifecycle !== 'STARTING') {
      return false;
    }
    const now = Date.now();
    const lastAdvance = Math.max(
      Number(session.lastSequenceAdvanceAt) || 0,
      Number(session.lastHealthyTickAt) || 0
    );
    const stallMs =
      lastAdvance > 0
        ? Math.max(0, now - lastAdvance)
        : Math.max(0, now - (Number(session.startTime) || now));
    return stallMs > getBillingChainHealStallMs();
  } catch {
    return false;
  }
}

/**
 * True when no healthy delayed/waiting/active cycle job exists for this call (e.g. lost after crash).
 */
export async function needsBillingCycleReschedule(callId: string): Promise<boolean> {
  const redis = getRedis();
  const q = getQueue();
  const gateKey = billingCycleScheduleGateKey(callId);

  if (await isBillingSequenceStalled(callId)) {
    await Promise.all([
      redis.del(gateKey).catch(() => 0),
      redis.del(`${BILLING_CYCLE_HEARTBEAT_PREFIX}${callId}`).catch(() => 0),
    ]);
    recordBillingMetric('billing_cycle_zombie_sequence_stall', 1, { callId });
    recordBillingMetric('billing_cycle_missing_recreated', 1, { callId, reason: 'sequence_stall' });
    return true;
  }

  const [gateRaw, heartbeatRaw] = await Promise.all([
    redis.get(gateKey),
    redis.get(`${BILLING_CYCLE_HEARTBEAT_PREFIX}${callId}`),
  ]);

  if (gateRaw) {
    recordBillingMetric('billing_cycle_exists_healthy', 1, {
      callId,
      state: 'scheduled_gate',
    });
    return false;
  }

  const healthWindowMs = readCycleHealthWindowMs();
  const heartbeatAt = Number(heartbeatRaw) || 0;
  if (heartbeatAt > 0 && Date.now() - heartbeatAt <= healthWindowMs) {
    recordBillingMetric('billing_cycle_exists_healthy', 1, {
      callId,
      state: 'recent_heartbeat',
    });
    return false;
  }

  const queueHealth = await hasHealthyQueuedCycleJob(q, callId);
  if (queueHealth.healthy) {
    recordBillingMetric('billing_cycle_exists_healthy', 1, {
      callId,
      state: queueHealth.state || 'unknown',
    });
    if (
      queueHealth.state === 'delayed' &&
      Number(queueHealth.delayMs || 0) > BILLING_PROCESS_INTERVAL_MS * 5
    ) {
      recordBillingMetric('billing_cycle_exists_but_stale', 1, {
        callId,
        state: 'delayed',
        delayMs: String(queueHealth.delayMs),
      });
    }
    return false;
  }

  recordBillingMetric('billing_cycle_missing_recreated', 1, { callId });
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
 * Uses unique BullMQ job ids plus a Redis schedule gate to guarantee successor scheduling
 * while preventing duplicate in-flight enqueue storms.
 */
export async function scheduleBillingJob(
  callId: string,
  delayMs: number = BILLING_PROCESS_INTERVAL_MS
): Promise<void> {
  assertBullmqRuntimeSafety();
  const redis = getRedis();
  const q = getQueue();
  const gateKey = billingCycleScheduleGateKey(callId);
  const ttlSeconds = Math.max(2, Math.ceil((Math.max(0, delayMs) + BILLING_PROCESS_INTERVAL_MS * 2) / 1000));
  const gateSet = await redis
    .set(gateKey, String(Date.now() + Math.max(0, delayMs)), 'EX', ttlSeconds, 'NX')
    .catch(() => null);
  recordBillingMetric('bullmq_cycle_enqueue_attempted', 1, { callId });
  if (gateSet !== 'OK') {
    recordBillingMetric('bullmq_cycle_enqueue_result', 1, {
      callId,
      result: 'duplicate_active',
    });
    return;
  }

  try {
    const jobId = buildCycleInstanceJobId(callId);
    await q.add(
      'cycle',
      { callId },
      {
        jobId,
        delay: delayMs,
        removeOnComplete: 200,
        removeOnFail: 200,
      }
    );
    await touchBillingCycleHeartbeat(callId);
    recordBillingMetric('bullmq_cycle_enqueue_result', 1, {
      callId,
      result: 'created',
      delayBucketMs: String(Math.max(0, delayMs)),
    });
  } catch (err) {
    recordBillingMetric('bullmq_cycle_enqueue_failed', 1, { callId });
    recordBillingMetric('bullmq_cycle_enqueue_result', 1, { callId, result: 'failed' });
    await redis.del(gateKey).catch(() => 0);
    logError('BullMQ cycle add failed', err, { callId, gateKey });
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
  const redis = getRedis();
  const q = getQueue();
  const scanLimit = readCycleQueueScanLimit();
  let removed = 0;
  for (const state of ['waiting', 'delayed'] as const) {
    const jobs = await q.getJobs([state], 0, scanLimit, true);
    for (const job of jobs) {
      if ((job.data as { callId?: string } | undefined)?.callId !== callId) {
        continue;
      }
      await job.remove().catch(() => {});
      removed += 1;
    }
  }
  await Promise.all([
    redis.del(billingCycleScheduleGateKey(callId)).catch(() => 0),
    redis.del(`${BILLING_CYCLE_HEARTBEAT_PREFIX}${callId}`).catch(() => 0),
  ]);
  recordBillingMetric('bullmq_cycle_cancelled', 1, { callId, removedCount: String(removed) });
}

export function startBillingBullWorker(): Worker | null {
  if (!shouldStartBillingBullWorker()) {
    logInfo('Billing BullMQ worker skipped for this process', {
      runsBillingWorkers: runsBillingWorkers(),
      concurrency: readBullmqConcurrency(),
    });
    return null;
  }
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
      const redis = getRedis();
      await redis.del(billingCycleScheduleGateKey(callId)).catch(() => 0);
      const queueLagMs = Math.max(0, Date.now() - (job.timestamp + (job.opts.delay || 0)));
      recordBillingMetric('bullmq_queue_lag_ms', queueLagMs, { callId });
      let lifecycleState: string | undefined;
      try {
        const sessionRaw = await redis.get(callSessionKey(callId));
        if (sessionRaw) {
          lifecycleState = (JSON.parse(sessionRaw) as { lifecycleState?: string }).lifecycleState;
        }
      } catch {
        lifecycleState = undefined;
      }
      const countsForAdmission = isLiveBillingLifecycle(lifecycleState);
      if (!countsForAdmission && queueLagMs > 0) {
        recordBillingMetric('billing_bp_queue_lag_ignored_recovery', 1, { callId });
      }
      updateBackpressureStage({
        queueLagMs: countsForAdmission ? queueLagMs : 0,
      });
      let result: Awaited<ReturnType<typeof billingService.processBillingTick>>;
      try {
        result = await billingService.processBillingTick(io, callId);
      } catch (err) {
        logError('BullMQ billing job threw', err, { callId });
        try {
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
      } else if (result === 'tick_deferred') {
        recordBillingMetric('bullmq_tick_deferred', 1, { callId });
        logBillingHealth('TICK_DEFERRED', { callId, source: 'bullmq_worker' });
        await scheduleBillingJob(callId, getBillingCycleLockDeferMs()).catch((e) =>
          logError('BullMQ schedule deferred tick failed', e, { callId })
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
