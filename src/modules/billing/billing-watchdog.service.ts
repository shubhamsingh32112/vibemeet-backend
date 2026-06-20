import { Server } from 'socket.io';
import {
  getRedis,
  ACTIVE_CALL_BY_USER_PREFIX,
  callSessionKey,
  billingWatchdogCooldownKey,
  billingWatchdogAttemptsKey,
  billingRecoveryDeadLetterKey,
  BILLING_WATCHDOG_LOCK_KEY,
} from '../../config/redis';
import {
  acquireDistributedLock,
  type DistributedLockHandle,
} from '../../utils/distributed-lock';
import { getBillingInstanceId } from './billing-instance-id';
import { logError, logInfo, logWarning } from '../../utils/logger';
import { recordBillingMetric } from '../../utils/monitoring';
import { recoverBillingScheduleForCall } from './billing-recovery';
import {
  finalizeCallSession,
  getRecoveryOwnerInstanceId,
  moveCallToRecoveryDeadLetter,
} from './billing-session-finalization.service';
import { isDurableCallSessionEnabled, isWatchdogAutoFinalizeEnabled } from './billing-phase-flags';
import { DurableCallSession } from './call-session.model';
import { recordWatchdogAlert } from './billing-phase-metrics';
import { featureFlags } from '../../config/feature-flags';
import { transitionBillingStateWithAudit } from './billing-lifecycle.machine';
import { randomUUID } from 'crypto';
import { isBullmqBillingEnabled, needsBillingCycleReschedule } from './billing.queue';

let watchdogTimer: NodeJS.Timeout | null = null;
let activeWatchdogLock: DistributedLockHandle | null = null;

function isWatchdogClusterLockEnabled(): boolean {
  return process.env.BILLING_WATCHDOG_CLUSTER_LOCK !== 'false';
}

function readInt(name: string, fallback: number, min: number, max: number): number {
  const n = parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const WATCHDOG_INTERVAL_MS = readInt('BILLING_WATCHDOG_INTERVAL_MS', 5000, 1000, 60000);
const STALLED_ACTIVE_MS = readInt('BILLING_WATCHDOG_STALLED_ACTIVE_MS', 45000, 5000, 600000);
const STALLED_SETTLING_MS = readInt('BILLING_WATCHDOG_STALLED_SETTLING_MS', 60000, 15000, 600000);
const STALLED_RECOVERING_MS = readInt('BILLING_WATCHDOG_STALLED_RECOVERING_MS', 30000, 5000, 600000);
const CHECKPOINT_LAG_MS = readInt('BILLING_WATCHDOG_CHECKPOINT_LAG_MS', 20000, 10000, 300000);
const RECENT_HEALTHY_ACTIVITY_MS = readInt(
  'BILLING_WATCHDOG_RECENT_HEALTHY_ACTIVITY_MS',
  20000,
  3000,
  120000
);
const WATCHDOG_COOLDOWN_SECONDS = readInt('BILLING_WATCHDOG_RECOVERY_COOLDOWN_SECONDS', 45, 10, 600);
const WATCHDOG_ATTEMPT_CAP = readInt('BILLING_WATCHDOG_RECOVERY_ATTEMPT_CAP', 6, 1, 100);
const WATCHDOG_ATTEMPT_TTL_SECONDS = readInt(
  'BILLING_WATCHDOG_RECOVERY_ATTEMPT_TTL_SECONDS',
  3600,
  60,
  86400
);
const CHAIN_HEAL_STALL_MS = readInt(
  'BILLING_WATCHDOG_CHAIN_HEAL_STALL_MS',
  7000,
  1500,
  120000
);

type BillingWatchdogSession = {
  callId: string;
  lastProcessedAt?: number;
  lastHealthyTickAt?: number;
  lastSocketEmitAt?: number;
  lastSequenceAdvanceAt?: number;
  lifecycleState?: string;
  billingSequence?: number;
  lastCheckpointAtMs?: number;
};

function hasRecentHealthyEvidence(session: BillingWatchdogSession, now: number): boolean {
  const healthyAt = Number(session.lastHealthyTickAt) || 0;
  const socketAt = Number(session.lastSocketEmitAt) || 0;
  const seqAt = Number(session.lastSequenceAdvanceAt) || 0;
  return (
    (healthyAt > 0 && now - healthyAt <= RECENT_HEALTHY_ACTIVITY_MS) ||
    (socketAt > 0 && now - socketAt <= RECENT_HEALTHY_ACTIVITY_MS) ||
    (seqAt > 0 && now - seqAt <= RECENT_HEALTHY_ACTIVITY_MS)
  );
}

async function getActiveCallIds(): Promise<Set<string>> {
  const redis = getRedis();
  const callIds = new Set<string>();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${ACTIVE_CALL_BY_USER_PREFIX}*`,
      'COUNT',
      200
    );
    cursor = next;
    if (!keys.length) continue;
    const values = await redis.mget(...keys);
    values.forEach((v) => {
      if (v && String(v).trim().length > 0) callIds.add(String(v));
    });
  } while (cursor !== '0');
  return callIds;
}

async function runWatchdogPass(io: Server): Promise<void> {
  const redis = getRedis();
  const now = Date.now();
  const watchdogPassId = randomUUID();
  const recoveryOwnerInstanceId = getRecoveryOwnerInstanceId();
  const callIds = await getActiveCallIds();
  recordBillingMetric('billing_watchdog_active_calls', callIds.size, {});

  if (isDurableCallSessionEnabled()) {
    const staleThreshold = new Date(now - STALLED_ACTIVE_MS);
    const staleMongo = await DurableCallSession.find({
      finalized: false,
      state: { $in: ['active', 'reconnecting', 'ending', 'settling'] },
      lastBillingAt: { $lt: staleThreshold },
    })
      .select('_id state lastBillingAt')
      .limit(100)
      .lean();

    for (const row of staleMongo) {
      recordWatchdogAlert(row._id, `mongo_stale_${row.state}`);
      logWarning('billing_watchdog_mongo_stale_alert', {
        callId: row._id,
        state: row.state,
        lastBillingAt: row.lastBillingAt,
        watchdogPassId,
        autoFinalize: isWatchdogAutoFinalizeEnabled(),
      });

      if (row.state !== 'settling' || !isWatchdogAutoFinalizeEnabled()) {
        continue;
      }
      if (await redis.get(billingRecoveryDeadLetterKey(row._id))) {
        continue;
      }
      if (await redis.get(billingWatchdogCooldownKey(row._id))) {
        recordBillingMetric('billing_watchdog_trigger_suppressed', 1, {
          callId: row._id,
          reason: 'cooldown_skip',
        });
        continue;
      }
      const attempt = await redis.incr(billingWatchdogAttemptsKey(row._id));
      await redis.expire(billingWatchdogAttemptsKey(row._id), WATCHDOG_ATTEMPT_TTL_SECONDS).catch(() => 0);
      if (attempt > WATCHDOG_ATTEMPT_CAP) {
        await moveCallToRecoveryDeadLetter(
          row._id,
          'watchdog_attempt_cap_reached',
          'reconciliation_worker'
        );
        continue;
      }
      await redis.setex(
        billingWatchdogCooldownKey(row._id),
        WATCHDOG_COOLDOWN_SECONDS,
        JSON.stringify({ attempt, watchdogPassId, recoveryOwnerInstanceId, at: now })
      );
      recordBillingMetric('billing_watchdog_stalled_settling', 1, { callId: row._id });
      logWarning('Watchdog auto-finalize for mongo stale settling durable session', {
        callId: row._id,
        watchdogAttempt: attempt,
        watchdogPassId,
        recoveryOwnerInstanceId,
      });
      await finalizeCallSession(io, {
        callId: row._id,
        reason: 'timeout',
        source: 'reconciliation_worker',
      });
    }
  }

  for (const callId of callIds) {
    try {
      const sessionRaw = await redis.get(callSessionKey(callId));
      if (!sessionRaw) continue;
      const session = JSON.parse(sessionRaw) as BillingWatchdogSession;
      const lifecycleState = String(session.lifecycleState || 'ACTIVE');
      if (lifecycleState === 'SETTLED' || lifecycleState === 'FAILED_RECOVERY_SETTLEMENT') {
        recordBillingMetric('billing_watchdog_terminal_short_circuit', 1, {
          callId,
          lifecycleState,
        });
        continue;
      }
      const lastProcessedAt = Number(session.lastProcessedAt) || 0;
      const stalledForMs = lastProcessedAt > 0 ? Math.max(0, now - lastProcessedAt) : 0;
      const healthyRecently = hasRecentHealthyEvidence(session, now);
      const lastSequenceAdvanceAt = Number(session.lastSequenceAdvanceAt) || 0;
      const sequenceStalledForMs =
        lastSequenceAdvanceAt > 0 ? Math.max(0, now - lastSequenceAdvanceAt) : stalledForMs;

      if (
        lifecycleState === 'ACTIVE' &&
        isBullmqBillingEnabled() &&
        sequenceStalledForMs > CHAIN_HEAL_STALL_MS
      ) {
        const chainMissing = await needsBillingCycleReschedule(callId).catch(() => false);
        if (chainMissing) {
          const recovered = await recoverBillingScheduleForCall(callId, 'reconciliation');
          recordBillingMetric('billing_watchdog_scheduler_chain_missing', 1, {
            callId,
            phase: 'active_fast_heal',
            recovered: recovered ? 'true' : 'false',
          });
          if (recovered) {
            continue;
          }
        }
      }

      if (lifecycleState === 'ACTIVE' && stalledForMs > STALLED_ACTIVE_MS) {
        if (healthyRecently) {
          recordBillingMetric('billing_watchdog_skip_recent_sequence_advance', 1, {
            callId,
            lifecycleState: 'ACTIVE',
          });
          continue;
        }
        if (isBullmqBillingEnabled()) {
          const chainMissing = await needsBillingCycleReschedule(callId).catch(() => false);
          if (chainMissing) {
            const recovered = await recoverBillingScheduleForCall(callId, 'reconciliation');
            recordBillingMetric('billing_watchdog_trigger_suppressed', 1, {
              callId,
              reason: recovered ? 'scheduler_chain_missing_recovered' : 'scheduler_chain_missing_unrecovered',
            });
            if (recovered) {
              logWarning('Watchdog detected scheduler chain gap on ACTIVE session', {
                callId,
                stalledForMs,
                watchdogPassId,
                recoveryOwnerInstanceId,
              });
              continue;
            }
          }
        }
        const transitioned = await transitionBillingStateWithAudit({
          callId,
          from: 'ACTIVE',
          to: 'RECOVERING',
          source: 'billing.watchdog',
          reason: 'stalled_active_detected',
        });
        if (transitioned.changed) {
          session.lifecycleState = transitioned.next;
          await redis.set(callSessionKey(callId), JSON.stringify(session), 'KEEPTTL');
        }
        recordBillingMetric('billing_watchdog_stalled_active', 1, { callId });
        logWarning('Watchdog detected stalled ACTIVE billing session', {
          callId,
          stalledForMs,
          watchdogPassId,
          recoveryOwnerInstanceId,
        });
        await recoverBillingScheduleForCall(callId, 'reconciliation');
      }

      if (lifecycleState === 'SETTLING' && stalledForMs > STALLED_SETTLING_MS) {
        if (healthyRecently) {
          recordBillingMetric('billing_watchdog_skip_recent_sequence_advance', 1, {
            callId,
            lifecycleState: 'SETTLING',
          });
          continue;
        }
        if (await redis.get(billingRecoveryDeadLetterKey(callId))) {
          continue;
        }
        if (await redis.get(billingWatchdogCooldownKey(callId))) {
          recordBillingMetric('billing_watchdog_trigger_suppressed', 1, {
            callId,
            reason: 'cooldown_skip',
          });
          continue;
        }
        const attempt = await redis.incr(billingWatchdogAttemptsKey(callId));
        await redis.expire(billingWatchdogAttemptsKey(callId), WATCHDOG_ATTEMPT_TTL_SECONDS).catch(() => 0);
        if (attempt > WATCHDOG_ATTEMPT_CAP) {
          await moveCallToRecoveryDeadLetter(
            callId,
            'watchdog_attempt_cap_reached',
            'reconciliation_worker'
          );
          continue;
        }
        await redis.setex(
          billingWatchdogCooldownKey(callId),
          WATCHDOG_COOLDOWN_SECONDS,
          JSON.stringify({ attempt, watchdogPassId, recoveryOwnerInstanceId, at: now })
        );
        recordBillingMetric('billing_watchdog_stalled_settling', 1, { callId });
        logWarning('Watchdog detected stalled SETTLING billing session', {
          callId,
          stalledForMs,
          watchdogAttempt: attempt,
          watchdogPassId,
          recoveryOwnerInstanceId,
        });
        recordWatchdogAlert(callId, 'stalled_settling');
        if (!isWatchdogAutoFinalizeEnabled()) {
          continue;
        }
        await finalizeCallSession(io, {
          callId,
          reason: 'timeout',
          source: 'reconciliation_worker',
        });
      }

      if (lifecycleState === 'RECOVERING' && stalledForMs > STALLED_RECOVERING_MS) {
        if (healthyRecently) {
          recordBillingMetric('billing_watchdog_skip_recent_sequence_advance', 1, {
            callId,
            lifecycleState: 'RECOVERING',
          });
          continue;
        }
        if (isBullmqBillingEnabled()) {
          const chainMissing = await needsBillingCycleReschedule(callId).catch(() => false);
          if (chainMissing) {
            const recovered = await recoverBillingScheduleForCall(callId, 'reconciliation');
            recordBillingMetric('billing_watchdog_trigger_suppressed', 1, {
              callId,
              reason: recovered
                ? 'recovering_scheduler_chain_missing_recovered'
                : 'recovering_scheduler_chain_missing_unrecovered',
            });
            if (recovered) {
              continue;
            }
          }
        }
        if (await redis.get(billingRecoveryDeadLetterKey(callId))) {
          continue;
        }
        if (await redis.get(billingWatchdogCooldownKey(callId))) {
          recordBillingMetric('billing_watchdog_trigger_suppressed', 1, {
            callId,
            reason: 'cooldown_skip',
          });
          continue;
        }
        const attempt = await redis.incr(billingWatchdogAttemptsKey(callId));
        await redis.expire(billingWatchdogAttemptsKey(callId), WATCHDOG_ATTEMPT_TTL_SECONDS).catch(() => 0);
        if (attempt > WATCHDOG_ATTEMPT_CAP) {
          await moveCallToRecoveryDeadLetter(
            callId,
            'watchdog_attempt_cap_reached',
            'reconciliation_worker'
          );
          continue;
        }
        await redis.setex(
          billingWatchdogCooldownKey(callId),
          WATCHDOG_COOLDOWN_SECONDS,
          JSON.stringify({ attempt, watchdogPassId, recoveryOwnerInstanceId, at: now })
        );
        const transitioned = await transitionBillingStateWithAudit({
          callId,
          from: 'RECOVERING',
          to: 'ENDING',
          source: 'billing.watchdog',
          reason: 'stalled_recovering_detected',
        });
        if (!transitioned.valid) {
          recordBillingMetric('billing_watchdog_trigger_suppressed', 1, {
            callId,
            reason: 'recovering_transition_blocked',
          });
          continue;
        }
        if (transitioned.changed) {
          session.lifecycleState = transitioned.next;
          await redis.set(callSessionKey(callId), JSON.stringify(session), 'KEEPTTL');
        }
        recordBillingMetric('billing_watchdog_stalled_recovering', 1, { callId });
        logWarning('Watchdog detected stalled RECOVERING billing session', {
          callId,
          stalledForMs,
          watchdogAttempt: attempt,
          watchdogPassId,
          recoveryOwnerInstanceId,
        });
        recordWatchdogAlert(callId, 'stalled_recovering');
        if (!isWatchdogAutoFinalizeEnabled()) {
          continue;
        }
        await finalizeCallSession(io, {
          callId,
          reason: 'timeout',
          source: 'reconciliation_worker',
        });
      }

      const billingSequence = Number(session.billingSequence) || 0;
      const lastCheckpointAtMs = Number(session.lastCheckpointAtMs) || 0;
      if (
        billingSequence > 0 &&
        lifecycleState === 'ACTIVE' &&
        lastCheckpointAtMs > 0 &&
        now - lastCheckpointAtMs > CHECKPOINT_LAG_MS
      ) {
        recordBillingMetric('billing_watchdog_checkpoint_lag', now - lastCheckpointAtMs, {
          callId,
        });
      }
    } catch (error) {
      logError('Billing watchdog call inspection failed', error, { callId });
    }
  }
}

async function runWatchdogPassWithLock(io: Server): Promise<void> {
  if (!isWatchdogClusterLockEnabled()) {
    await runWatchdogPass(io);
    return;
  }

  const handle = await acquireDistributedLock({
    key: BILLING_WATCHDOG_LOCK_KEY,
    ttlMs: WATCHDOG_INTERVAL_MS * 3,
    ownerId: getBillingInstanceId(),
    heartbeat: true,
    onSkipped: () => recordBillingMetric('billing.watchdog.lock_skipped', 1, {}),
  });
  if (!handle) return;

  recordBillingMetric('billing.watchdog.lock_acquired', 1, {});
  activeWatchdogLock = handle;
  try {
    await runWatchdogPass(io);
  } finally {
    await handle.release();
    if (activeWatchdogLock === handle) {
      activeWatchdogLock = null;
    }
  }
}

export function startBillingWatchdog(io: Server): void {
  if (!featureFlags.billingWatchdogEnabled) {
    return;
  }
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    runWatchdogPassWithLock(io).catch((err) => {
      logError('Billing watchdog pass failed', err, {});
    });
  }, WATCHDOG_INTERVAL_MS);
  logInfo('Billing watchdog started', { intervalMs: WATCHDOG_INTERVAL_MS });
}

export function stopBillingWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  const lock = activeWatchdogLock;
  if (lock) {
    void lock.release();
    activeWatchdogLock = null;
  }
}
