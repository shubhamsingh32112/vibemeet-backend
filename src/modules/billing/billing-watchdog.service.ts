import { Server } from 'socket.io';
import {
  getRedis,
  ACTIVE_CALL_BY_USER_PREFIX,
  callSessionKey,
} from '../../config/redis';
import { logError, logInfo, logWarning } from '../../utils/logger';
import { recordBillingMetric } from '../../utils/monitoring';
import { recoverBillingScheduleForCall } from './billing-recovery';
import { finalizeCallSession } from './billing-session-finalization.service';
import { featureFlags } from '../../config/feature-flags';
import { transitionBillingStateWithAudit } from './billing-lifecycle.machine';

let watchdogTimer: NodeJS.Timeout | null = null;

function readInt(name: string, fallback: number, min: number, max: number): number {
  const n = parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const WATCHDOG_INTERVAL_MS = readInt('BILLING_WATCHDOG_INTERVAL_MS', 5000, 1000, 60000);
const STALLED_ACTIVE_MS = readInt('BILLING_WATCHDOG_STALLED_ACTIVE_MS', 15000, 5000, 600000);
const STALLED_SETTLING_MS = readInt('BILLING_WATCHDOG_STALLED_SETTLING_MS', 60000, 15000, 600000);
const STALLED_RECOVERING_MS = readInt('BILLING_WATCHDOG_STALLED_RECOVERING_MS', 30000, 5000, 600000);
const CHECKPOINT_LAG_MS = readInt('BILLING_WATCHDOG_CHECKPOINT_LAG_MS', 20000, 10000, 300000);

type BillingWatchdogSession = {
  callId: string;
  lastProcessedAt?: number;
  lifecycleState?: string;
  billingSequence?: number;
  lastCheckpointAtMs?: number;
};

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

      if (lifecycleState === 'ACTIVE' && stalledForMs > STALLED_ACTIVE_MS) {
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
        });
        await recoverBillingScheduleForCall(callId, 'reconciliation');
      }

      if (lifecycleState === 'SETTLING' && stalledForMs > STALLED_SETTLING_MS) {
        await transitionBillingStateWithAudit({
          callId,
          from: 'SETTLING',
          to: 'FAILED',
          source: 'billing.watchdog',
          reason: 'stalled_settling_detected',
        });
        recordBillingMetric('billing_watchdog_stalled_settling', 1, { callId });
        logWarning('Watchdog detected stalled SETTLING billing session', {
          callId,
          stalledForMs,
        });
        await finalizeCallSession(io, {
          callId,
          reason: 'timeout',
          source: 'reconciliation_worker',
        });
      }

      if (lifecycleState === 'RECOVERING' && stalledForMs > STALLED_RECOVERING_MS) {
        await transitionBillingStateWithAudit({
          callId,
          from: 'RECOVERING',
          to: 'FAILED',
          source: 'billing.watchdog',
          reason: 'stalled_recovering_detected',
        });
        recordBillingMetric('billing_watchdog_stalled_recovering', 1, { callId });
        logWarning('Watchdog detected stalled RECOVERING billing session', {
          callId,
          stalledForMs,
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
