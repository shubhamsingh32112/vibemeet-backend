import os from 'os';

/** Canonical billing runtime instance id (hostname:pid unless overridden). */
export function getBillingInstanceId(): string {
  const configured = process.env.BILLING_INSTANCE_ID?.trim();
  if (configured) return configured;
  return `${os.hostname()}:${process.pid}`;
}

/**
 * Compare stored vs worker instance ids, tolerating legacy pid-only session values.
 */
export function billingInstanceIdsMatch(stored: string, worker: string): boolean {
  const a = String(stored || '').trim();
  const b = String(worker || '').trim();
  if (!a || !b) return false;
  if (a === b) return true;

  // Sessions written before instance-id unification stored pid-only values.
  if (!a.includes(':')) {
    return b === a || b.endsWith(`:${a}`);
  }
  if (!b.includes(':')) {
    return a === b || a.endsWith(`:${b}`);
  }
  return false;
}
