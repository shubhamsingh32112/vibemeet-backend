import { Server } from 'socket.io';
import {
  getRedis,
  ACTIVE_CALL_BY_USER_PREFIX,
  callSessionKey,
  billingWatchdogCooldownKey,
  billingWatchdogAttemptsKey,
  billingRecoveryDeadLetterKey,
} from '../../config/redis';
import { logError, logInfo, logWarning } from '../../utils/logger';
import { recordBillingMetric } from '../../utils/monitoring';
import { recoverBillingScheduleForCall } from './billing-recovery';
import {
  finalizeCallSession,
  getRecoveryOwnerInstanceId,
  moveCallToRecoveryDeadLetter,
} from './billing-session-finalization.service';
import { featureFlags } from '../../config/feature-flags';
import { transitionBillingStateWithAudit } from './billing-lifecycle.machine';
import { randomUUID } from 'crypto';

let watchdogTimer: NodeJS.Timeout | null = null;

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

  for (const callId of callIds) {
    try {
      const sessionRaw = await redis.get(callSessionKey(callId));
      if (!sessionRaw) continue;
      const session = JSON.parse(sessionRaw) as BillingWatchdogSession;
      const lifecycleState = String(session.lifecycleState || 'ACTIVE');
      const lastProcessedAt = Number(session.lastProcessedAt) || 0;
      const stalledForMs = lastProcessedAt > 0 ? Math.max(0, now - lastProcessedAt) : 0;
      const healthyRecently = hasRecentHealthyEvidence(session, now);

      if (lifecycleState === 'ACTIVE' && stalledForMs > STALLED_ACTIVE_MS) {
        if (healthyRecently) {
          recordBillingMetric('billing_watchdog_skip_recent_sequence_advance', 1, {
            callId,
            lifecycleState: 'ACTIVE',
          });
          continue;
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
        await transitionBillingStateWithAudit({
          callId,
          from: 'RECOVERING',
          to: 'ENDING',
          source: 'billing.watchdog',
          reason: 'stalled_recovering_detected',
        });
        recordBillingMetric('billing_watchdog_stalled_recovering', 1, { callId });
        logWarning('Watchdog detected stalled RECOVERING billing session', {
          callId,
          stalledForMs,
          watchdogAttempt: attempt,
          watchdogPassId,
          recoveryOwnerInstanceId,
        });
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

export function startBillingWatchdog(io: Server): void {
  if (!featureFlags.billingWatchdogEnabled) {
    return;
  }
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    runWatchdogPass(io).catch((err) => {
      logError('Billing watchdog pass failed', err, {});
    });
  }, WATCHDOG_INTERVAL_MS);
  logInfo('Billing watchdog started', { intervalMs: WATCHDOG_INTERVAL_MS });
}

export function stopBillingWatchdog(): void {
  if (!watchdogTimer) return;
  clearInterval(watchdogTimer);
  watchdogTimer = null;
}
