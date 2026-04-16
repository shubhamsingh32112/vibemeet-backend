import { getRedis } from '../../config/redis';

const CALL_ENDED_MARKER_TTL_SECONDS = 300;

/** Short-lived lease so only one path calls Stream mark_ended at a time (distinct from completion marker). */
const MARK_ENDED_LEASE_PREFIX = 'billing:mark_ended_lease:';

function readMarkEndedLeaseTtlSeconds(): number {
  const raw = parseInt(process.env.BILLING_MARK_ENDED_LEASE_TTL_SECONDS || '120', 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 120;
  }
  return Math.min(600, Math.max(30, raw));
}

export function markEndedLeaseKey(callId: string): string {
  return `${MARK_ENDED_LEASE_PREFIX}${callId}`;
}

export function callEndedMarkerKey(callId: string): string {
  return `call:ended:${callId}`;
}

/**
 * Atomically acquire the right to call Stream mark_ended for this callId.
 * On Stream failure, call releaseMarkEndedLease so retries can re-acquire.
 */
export async function tryAcquireMarkEndedLease(callId: string): Promise<boolean> {
  const redis = getRedis();
  const r = await redis.set(
    markEndedLeaseKey(callId),
    '1',
    'EX',
    readMarkEndedLeaseTtlSeconds(),
    'NX'
  );
  return r === 'OK';
}

export async function releaseMarkEndedLease(callId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(markEndedLeaseKey(callId)).catch(() => {});
}

export async function hasCallEndedMarker(callId: string): Promise<boolean> {
  const redis = getRedis();
  const exists = await redis.exists(callEndedMarkerKey(callId));
  return exists === 1;
}

export async function setCallEndedMarker(callId: string): Promise<void> {
  const redis = getRedis();
  await redis.setex(callEndedMarkerKey(callId), CALL_ENDED_MARKER_TTL_SECONDS, '1');
}
