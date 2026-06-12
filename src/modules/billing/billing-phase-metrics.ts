import { recordBillingMetric } from '../../utils/monitoring';

export function recordFinalizeDuplicatePrevented(callId: string, source: string): void {
  recordBillingMetric('billing_finalize_duplicate_prevented', 1, { callId, source });
}

export function recordSettlementRetry(callId: string, reason: string): void {
  recordBillingMetric('billing_settlement_retry_count', 1, { callId, reason });
}

export function recordPersistLagSeconds(callId: string, lagSeconds: number): void {
  recordBillingMetric('billing_persist_lag_seconds', lagSeconds, { callId });
}

export function recordPendingRecentsAgeSeconds(callId: string, ageSeconds: number): void {
  recordBillingMetric('call_history_pending_recents_age_seconds', ageSeconds, { callId });
}

export function recordDualWriteDrift(callId: string, field: string, deltaMicros: number): void {
  recordBillingMetric('call_session_dual_write_drift', Math.abs(deltaMicros), { callId, field });
}

export function recordStaleFencingReject(callId: string, reason: string): void {
  recordBillingMetric('billing_stale_fencing_reject_count', 1, { callId, reason });
}

export function recordLeaseTakeover(callId: string, previousOwner: string): void {
  recordBillingMetric('billing_lease_takeover_count', 1, { callId, previousOwner });
}

export function recordReconnectGenerationMismatch(callId: string): void {
  recordBillingMetric('billing_reconnect_generation_mismatch', 1, { callId });
}

export function recordLedgerOverlapDetected(callId: string): void {
  recordBillingMetric('billing_ledger_overlap_detected', 1, { callId });
}

export function recordReconciliationDrift(callId: string, field: string): void {
  recordBillingMetric('billing_reconciliation_drift_count', 1, { callId, field });
}

export function recordOrphanedSessionRecovered(callId: string, recoveredBy: string): void {
  recordBillingMetric('billing_orphaned_sessions_recovered', 1, { callId, recoveredBy });
}

export function recordWatchdogAlert(callId: string, alertType: string): void {
  recordBillingMetric('billing_watchdog_alert_count', 1, { callId, alertType });
}
