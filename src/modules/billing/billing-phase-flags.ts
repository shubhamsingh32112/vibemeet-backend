export function isDurableCallSessionEnabled(): boolean {
  return process.env.DURABLE_CALL_SESSION_ENABLED === 'true';
}

export function isBillingOwnershipV2Enabled(): boolean {
  return process.env.BILLING_OWNERSHIP_V2_ENABLED === 'true';
}

export function isIncrementalBillingPersistEnabled(): boolean {
  return process.env.INCREMENTAL_BILLING_PERSIST_ENABLED === 'true';
}

export function isBillingOutboxProjectionEnabled(): boolean {
  return process.env.BILLING_OUTBOX_PROJECTION_ENABLED === 'true';
}

export function isWatchdogAutoFinalizeEnabled(): boolean {
  return process.env.BILLING_WATCHDOG_AUTO_FINALIZE_ENABLED === 'true';
}

export const CALL_SESSION_MIRROR_INTERVAL_MS = Math.min(
  60_000,
  Math.max(1000, parseInt(process.env.CALL_SESSION_MIRROR_INTERVAL_MS || '5000', 10) || 5000)
);

export const CALL_SESSION_LEASE_TTL_MS = Math.min(
  120_000,
  Math.max(5000, parseInt(process.env.CALL_SESSION_LEASE_TTL_MS || '15000', 10) || 15000)
);

export const BILLING_LEDGER_GAP_TOLERANCE_MS = Math.min(
  10_000,
  Math.max(0, parseInt(process.env.BILLING_LEDGER_GAP_TOLERANCE_MS || '2000', 10) || 2000)
);
