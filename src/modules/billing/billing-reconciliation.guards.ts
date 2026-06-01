/**
 * Pure helpers for billing reconciliation repair decisions.
 * Kept in a separate module so unit tests do not import the full reconciliation job.
 */

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
