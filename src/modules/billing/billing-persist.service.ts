import { BillingLedger } from './billing-ledger.model';
import { DurableCallSession } from './call-session.model';
import {
  getPersistGuardForCall,
  mirrorRedisSessionToDurableCallSession,
} from './call-session.service';
import {
  BILLING_LEDGER_GAP_TOLERANCE_MS,
  isBillingOwnershipV2Enabled,
  isIncrementalBillingPersistEnabled,
} from './billing-phase-flags';
import {
  recordLedgerOverlapDetected,
  recordPersistLagSeconds,
  recordReconciliationDrift,
} from './billing-phase-metrics';
import { getRedis, callSessionKey } from '../../config/redis';
import { getBillingInstanceId } from './billing-instance-id';
import { logInfo, logWarning } from '../../utils/logger';
import type { CallSession as RedisCallSession } from './billing.service';
import type { BillingLedgerFlushReason } from './billing-ledger.model';

const lastPersistAtMsByCallId = new Map<string, number>();
const BILLING_PERSIST_INTERVAL_MS = Math.min(
  60_000,
  Math.max(1000, parseInt(process.env.BILLING_PERSIST_INTERVAL_MS || '5000', 10) || 5000)
);

export function shouldRunPeriodicPersist(callId: string, nowMs: number = Date.now()): boolean {
  const last = lastPersistAtMsByCallId.get(callId) || 0;
  return nowMs - last >= BILLING_PERSIST_INTERVAL_MS;
}

export async function flushBillingPersist(
  callId: string,
  session: RedisCallSession,
  flushReason: BillingLedgerFlushReason
): Promise<void> {
  if (!isIncrementalBillingPersistEnabled()) {
    await mirrorOnly(callId, session);
    return;
  }

  const now = new Date();
  const accrualEndAt = now;
  const accrualStartAt = new Date(
    Math.max(session.startTime, (session.lastProcessedAt || session.startTime) - BILLING_PERSIST_INTERVAL_MS)
  );
  const billedDurationMs = Math.max(0, accrualEndAt.getTime() - accrualStartAt.getTime());

  const durable = await DurableCallSession.findById(callId).lean();
  if (!durable || durable.finalized) return;

  const prevTick = durable.lastPersistedTickNumber ?? 0;
  const tickNumber = prevTick + 1;

  const prevUserTotal = durable.totalUserDebitedMicros ?? 0;
  const prevCreatorTotal = durable.totalCreatorCreditedMicros ?? 0;
  const userDebitMicros = Math.max(0, (session.totalDeductedMicros ?? 0) - prevUserTotal);
  const creatorCreditMicros = Math.max(0, (session.totalEarnedMicros ?? 0) - prevCreatorTotal);

  if (userDebitMicros === 0 && creatorCreditMicros === 0 && flushReason === 'periodic') {
    lastPersistAtMsByCallId.set(callId, Date.now());
    return;
  }

  const instanceId = getBillingInstanceId();
  let guard = isBillingOwnershipV2Enabled() ? await getPersistGuardForCall(callId) : null;
  if (isBillingOwnershipV2Enabled() && guard && guard.instanceId !== instanceId) {
    return;
  }

  const idempotencyKey = `call_${callId}_tick_${tickNumber}`;

  try {
    await BillingLedger.create({
      callId,
      tickNumber,
      accrualStartAt,
      accrualEndAt,
      billedDurationMs,
      userDebitMicros,
      creatorCreditMicros,
      billingSequenceStart: Math.max(0, (session.billingSequence ?? 1) - 1),
      billingSequenceEnd: session.billingSequence ?? 0,
      sourceInstanceId: instanceId,
      reconnectGeneration: durable.reconnectGeneration ?? 0,
      fencingToken: durable.fencingToken ?? 1,
      flushReason,
      idempotencyKey,
    });
  } catch (err: unknown) {
    if ((err as { code?: number }).code === 11000) {
      logInfo('billing_ledger_idempotent_skip', { callId, tickNumber });
      return;
    }
    throw err;
  }

  if (tickNumber > 1) {
    const prevRow = await BillingLedger.findOne({ callId, tickNumber: tickNumber - 1 }).lean();
    if (prevRow?.accrualEndAt) {
      const gapMs = accrualStartAt.getTime() - prevRow.accrualEndAt.getTime();
      if (gapMs > BILLING_LEDGER_GAP_TOLERANCE_MS) {
        recordReconciliationDrift(callId, 'accrual_gap');
        logWarning('billing_ledger_accrual_gap', { callId, gapMs, tickNumber });
      }
      if (gapMs < 0) {
        recordLedgerOverlapDetected(callId);
        logWarning('billing_ledger_overlap', { callId, gapMs, tickNumber });
      }
    }
  }

  await DurableCallSession.updateOne(
    { _id: callId, finalized: false },
    {
      $set: {
        totalUserDebitedMicros: session.totalDeductedMicros ?? 0,
        totalCreatorCreditedMicros: session.totalEarnedMicros ?? 0,
        accumulatedDurationSec: session.elapsedSeconds ?? 0,
        billingSequence: session.billingSequence ?? 0,
        lastBillingAt: now,
        lastServerAccrualAt: accrualEndAt,
        lastPersistedTickNumber: tickNumber,
        ...(isBillingOwnershipV2Enabled()
          ? {
              leaseExpiresAt: new Date(Date.now() + 15000),
            }
          : {}),
      },
    }
  );

  lastPersistAtMsByCallId.set(callId, Date.now());
  const lagSec = Math.max(0, (Date.now() - (session.lastProcessedAt || session.startTime)) / 1000);
  recordPersistLagSeconds(callId, lagSec);
}

async function mirrorOnly(callId: string, session: RedisCallSession): Promise<void> {
  const guard = isBillingOwnershipV2Enabled() ? (await getPersistGuardForCall(callId)) ?? undefined : undefined;
  await mirrorRedisSessionToDurableCallSession(callId, session, guard);
}

export async function maybePeriodicBillingPersist(
  callId: string,
  session: RedisCallSession
): Promise<void> {
  if (!shouldRunPeriodicPersist(callId)) return;
  await flushBillingPersist(callId, session, 'periodic');
}

export function clearPersistTracking(callId: string): void {
  lastPersistAtMsByCallId.delete(callId);
}

export async function flushBillingPersistForCallId(
  callId: string,
  flushReason: BillingLedgerFlushReason,
  sessionOverride?: RedisCallSession
): Promise<void> {
  let session = sessionOverride;
  if (!session) {
    const raw = await getRedis().get(callSessionKey(callId));
    if (!raw) return;
    session = JSON.parse(raw) as RedisCallSession;
  }
  const lifecycle = String(session.lifecycleState || '');
  if (lifecycle === 'SETTLED' || lifecycle === 'FAILED') return;
  await flushBillingPersist(callId, session, flushReason);
}
