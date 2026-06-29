/**
 * Resolves authoritative billing totals when Redis session is missing or stale.
 * Priority: live Redis → DurableCallSession → BillingLedger → checkpoint.
 */

import { getRedis, callSessionKey } from '../../config/redis';
import { getBillingCheckpoint } from './billing-checkpoint.service';
import { sumLedgerForCall } from './billing-ledger.model';
import { getDurableCallSession } from './call-session.service';
import { isDurableCallSessionEnabled } from './billing-phase-flags';
import { recordBillingMetric } from '../../utils/monitoring';
import { logInfo } from '../../utils/logger';

export type AuthoritativeTotalsSource = 'redis' | 'durable' | 'ledger' | 'checkpoint' | 'none';

export interface AuthoritativeSettlementTotals {
  totalDeductedMicros: number;
  totalEarnedMicros: number;
  billingSequence: number;
  source: AuthoritativeTotalsSource;
}

export async function resolveAuthoritativeSettlementTotals(
  callId: string
): Promise<AuthoritativeSettlementTotals> {
  const redis = getRedis();
  const sessionRaw = await redis.get(callSessionKey(callId));
  if (sessionRaw) {
    try {
      const session = JSON.parse(sessionRaw) as {
        totalDeductedMicros?: number;
        totalEarnedMicros?: number;
        billingSequence?: number;
      };
      const totalDeductedMicros = Math.max(0, Number(session.totalDeductedMicros) || 0);
      const totalEarnedMicros = Math.max(0, Number(session.totalEarnedMicros) || 0);
      const billingSequence = Math.max(0, Number(session.billingSequence) || 0);
      if (totalDeductedMicros > 0 || totalEarnedMicros > 0 || billingSequence > 0) {
        return { totalDeductedMicros, totalEarnedMicros, billingSequence, source: 'redis' };
      }
    } catch {
      /* fall through */
    }
  }

  if (isDurableCallSessionEnabled()) {
    const durable = await getDurableCallSession(callId);
    if (durable) {
      const totalDeductedMicros = Math.max(0, Number(durable.totalUserDebitedMicros) || 0);
      const totalEarnedMicros = Math.max(0, Number(durable.totalCreatorCreditedMicros) || 0);
      const billingSequence = Math.max(0, Number(durable.billingSequence) || 0);
      if (totalDeductedMicros > 0 || totalEarnedMicros > 0 || billingSequence > 0) {
        recordBillingMetric('settlement_totals_from_durable', 1, { callId });
        return { totalDeductedMicros, totalEarnedMicros, billingSequence, source: 'durable' };
      }
    }
  }

  try {
    const ledgerSum = await sumLedgerForCall(callId);
    if (ledgerSum.tickCount > 0) {
      recordBillingMetric('settlement_totals_from_ledger', 1, { callId });
      return {
        totalDeductedMicros: Math.max(0, ledgerSum.userDebitMicros),
        totalEarnedMicros: Math.max(0, ledgerSum.creatorCreditMicros),
        billingSequence: ledgerSum.tickCount,
        source: 'ledger',
      };
    }
  } catch {
    /* fall through */
  }

  const checkpoint = await getBillingCheckpoint(callId);
  if (checkpoint) {
    const totalDeductedMicros = Math.max(0, Number((checkpoint as { totalDeductedMicros?: number }).totalDeductedMicros) || 0);
    const totalEarnedMicros = Math.max(0, Number((checkpoint as { totalEarnedMicros?: number }).totalEarnedMicros) || 0);
    const billingSequence = Math.max(0, Number((checkpoint as { billingSequence?: number }).billingSequence) || 0);
    recordBillingMetric('settlement_totals_from_checkpoint', 1, { callId });
    return { totalDeductedMicros, totalEarnedMicros, billingSequence, source: 'checkpoint' };
  }

  return { totalDeductedMicros: 0, totalEarnedMicros: 0, billingSequence: 0, source: 'none' };
}

/** Merge authoritative totals into a session object when checkpoint/redis totals are zero but billing ran. */
export function applyAuthoritativeTotalsToSession<
  T extends {
    totalDeductedMicros?: number;
    totalEarnedMicros?: number;
    billingSequence?: number;
    elapsedSeconds?: number;
    pricePerSecondMicros?: number;
  }
>(session: T, totals: AuthoritativeSettlementTotals): T {
  if (totals.source === 'none') {
    return session;
  }
  const deduct = Math.max(Number(session.totalDeductedMicros) || 0, totals.totalDeductedMicros);
  const earn = Math.max(Number(session.totalEarnedMicros) || 0, totals.totalEarnedMicros);
  const seq = Math.max(Number(session.billingSequence) || 0, totals.billingSequence);
  if (deduct === Number(session.totalDeductedMicros) && earn === Number(session.totalEarnedMicros)) {
    return session;
  }
  const pricePerSecondMicros = Math.max(0, Number(session.pricePerSecondMicros) || 0);
  const elapsedSeconds =
    pricePerSecondMicros > 0 ? Math.floor(deduct / pricePerSecondMicros) : Number(session.elapsedSeconds) || 0;
  logInfo('settlement_authoritative_totals_merged', {
    source: totals.source,
    totalDeductedMicros: deduct,
    totalEarnedMicros: earn,
    billingSequence: seq,
  });
  return {
    ...session,
    totalDeductedMicros: deduct,
    totalEarnedMicros: earn,
    billingSequence: seq,
    elapsedSeconds,
  };
}
