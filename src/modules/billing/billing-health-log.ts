import { logDebug, logInfo, logWarning } from '../../utils/logger';
import { recordBillingMetric } from '../../utils/monitoring';

export type BillingHealthEvent =
  | 'TICK_OK'
  | 'TICK_DEFERRED'
  | 'TICK_SHORT_DELTA'
  | 'EMIT_SENT'
  | 'EMIT_KEEPALIVE'
  | 'EMIT_STALLED'
  | 'RECOVERY_HEAL_START'
  | 'RECOVERY_HEAL_DONE'
  | 'TOMBSTONE_CLEARED'
  | 'CHAIN_RESCHEDULED'
  | 'TERMINAL_BLOCKED_ACTIVE_SLOT'
  | 'SEQUENCE_STALL'
  | 'PRICING_REPAIR_START'
  | 'PRICING_REPAIR_DONE'
  | 'PRICING_REPAIR_FAILED';

const PREFIX = '🧾 BILLING_HEALTH';

function emitStallMetric(event: BillingHealthEvent, callId: string): void {
  recordBillingMetric('billing_health_event', 1, { callId, event });
}

export function logBillingHealth(
  event: BillingHealthEvent,
  fields: Record<string, string | number | boolean | null | undefined>
): void {
  emitStallMetric(event, String(fields.callId ?? ''));
  logInfo(`${PREFIX} ${event}`, fields);
}

export function logBillingHealthWarn(
  event: BillingHealthEvent,
  fields: Record<string, string | number | boolean | null | undefined>
): void {
  emitStallMetric(event, String(fields.callId ?? ''));
  logWarning(`${PREFIX} ${event}`, fields);
}

export function logBillingHealthDebug(
  event: BillingHealthEvent,
  fields: Record<string, string | number | boolean | null | undefined>
): void {
  logDebug(`${PREFIX} ${event}`, fields);
}

export function billingHealthFieldsFromSession(session: {
  callId?: string;
  billingSequence?: number;
  elapsedSeconds?: number;
  lifecycleState?: string;
  lastSequenceAdvanceAt?: number;
  lastEmitAtMs?: number;
  lastSocketEmitAt?: number;
  totalDeductedMicros?: number;
  totalEarnedMicros?: number;
}): Record<string, string | number> {
  const now = Date.now();
  const lastSeq = Number(session.lastSequenceAdvanceAt) || 0;
  const lastEmit = Number(session.lastEmitAtMs ?? session.lastSocketEmitAt) || 0;
  return {
    callId: String(session.callId ?? ''),
    billingSequence: Math.max(0, Number(session.billingSequence) || 0),
    elapsedSeconds: Math.max(0, Number(session.elapsedSeconds) || 0),
    lifecycleState: String(session.lifecycleState ?? 'UNKNOWN'),
    sequenceStallMs: lastSeq > 0 ? Math.max(0, now - lastSeq) : 0,
    emitStallMs: lastEmit > 0 ? Math.max(0, now - lastEmit) : 0,
    totalDeductedMicros: Math.max(0, Number(session.totalDeductedMicros) || 0),
    totalEarnedMicros: Math.max(0, Number(session.totalEarnedMicros) || 0),
  };
}
