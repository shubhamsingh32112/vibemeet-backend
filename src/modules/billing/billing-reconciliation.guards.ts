/**
 * Pure helpers for billing reconciliation repair decisions.
 * Kept in a separate module so unit tests do not import the full reconciliation job.
 */

import { isNonTerminalLifecycle } from './billing-active-call.service';
import type { AuthoritativeSettlementTotals } from './billing-settlement-totals.service';

export function isBlockZeroSettlementEnabled(): boolean {
  return process.env.BILLING_BLOCK_ZERO_SETTLEMENT_ENABLED !== 'false';
}

export function shouldBlockZeroSettlement(totals: AuthoritativeSettlementTotals): {
  blocked: boolean;
  reason?: string;
} {
  if (!isBlockZeroSettlementEnabled()) {
    return { blocked: false };
  }
  if (totals.totalDeductedMicros > 0) {
    return { blocked: false };
  }
  if (totals.billingSequence > 0) {
    return {
      blocked: true,
      reason: 'zero_deduct_with_positive_sequence',
    };
  }
  if (totals.source === 'durable' || totals.source === 'ledger') {
    return {
      blocked: true,
      reason: `zero_deduct_authoritative_${totals.source}`,
    };
  }
  if (totals.totalEarnedMicros > 0 && totals.totalDeductedMicros === 0 && totals.source !== 'none') {
    return {
      blocked: true,
      reason: 'zero_deduct_with_positive_earn',
    };
  }
  return { blocked: false };
}

export function shouldRescheduleBillingCycleForSession(
  session: { lifecycleState?: string } | null,
  settledTombstonePresent: boolean
): boolean {
  if (settledTombstonePresent) return false;
  if (!session) return false;
  return isNonTerminalLifecycle(session.lifecycleState);
}

export function shouldFinalizeSessionNoHistory(
  sess: {
    totalDeductedMicros?: number;
    lifecycleState?: string;
    lastProcessedAt?: number;
    lastEmitAtMs?: number;
  },
  nowMs: number,
  minAgeMs: number
): { shouldFinalize: boolean; skipReason?: string } {
  if ((sess.totalDeductedMicros ?? 0) <= 0) {
    return { shouldFinalize: false, skipReason: 'no_deductions' };
  }
  const lifecycle = String(sess.lifecycleState || 'ACTIVE').toUpperCase();
  const isTerminal = lifecycle === 'SETTLED' || lifecycle === 'FAILED';
  if (!isTerminal) {
    return { shouldFinalize: false, skipReason: 'live_session_no_history' };
  }
  const heartbeatMs = Math.max(0, Number(sess.lastProcessedAt) || 0, Number(sess.lastEmitAtMs) || 0);
  if (heartbeatMs > 0 && nowMs - heartbeatMs < minAgeMs) {
    return { shouldFinalize: false, skipReason: 'terminal_but_recent_no_history' };
  }
  return { shouldFinalize: true };
}
