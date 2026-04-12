import { getRedis, callSessionKey, isRedisConfigured } from '../../config/redis';
import { parseAppVideoCallId } from './billing-call-id.util';

export type BillingRestDeny = { ok: false; status: number; error: string };
export type BillingRestAllow = { ok: true };

/**
 * Ensures the authenticated user is the payer encoded in `callId` and body fields match.
 */
export function assertBillingRestCallStartedAccess(
  firebaseUid: string,
  callId: string,
  creatorFirebaseUid: string,
  creatorMongoId: string
): BillingRestDeny | BillingRestAllow {
  const parsed = parseAppVideoCallId(callId);
  if (!parsed) {
    return { ok: false, status: 400, error: 'Invalid callId format' };
  }
  if (parsed.callerFirebaseUid !== firebaseUid) {
    return { ok: false, status: 403, error: 'callId does not match authenticated user' };
  }
  if (parsed.creatorMongoId !== creatorMongoId) {
    return {
      ok: false,
      status: 400,
      error: 'creatorMongoId does not match callId',
    };
  }
  if (!creatorFirebaseUid) {
    return { ok: false, status: 400, error: 'Missing creatorFirebaseUid' };
  }
  return { ok: true };
}

/**
 * Ensures the authenticated user is a billing party (payer or creator) for this call.
 */
export async function assertBillingRestCallEndedAccess(
  firebaseUid: string,
  callId: string
): Promise<BillingRestDeny | BillingRestAllow> {
  if (!isRedisConfigured()) {
    const parsed = parseAppVideoCallId(callId);
    if (parsed && parsed.callerFirebaseUid === firebaseUid) {
      return { ok: true };
    }
    return { ok: false, status: 503, error: 'Billing storage unavailable' };
  }

  const redis = getRedis();
  const raw = await redis.get(callSessionKey(callId));
  if (raw) {
    try {
      const s = JSON.parse(raw as string) as {
        userFirebaseUid?: string;
        creatorFirebaseUid?: string;
      };
      if (
        s.userFirebaseUid === firebaseUid ||
        s.creatorFirebaseUid === firebaseUid
      ) {
        return { ok: true };
      }
      return { ok: false, status: 403, error: 'Not a participant in this call' };
    } catch {
      return { ok: false, status: 500, error: 'Invalid billing session' };
    }
  }

  const parsed = parseAppVideoCallId(callId);
  if (parsed && parsed.callerFirebaseUid === firebaseUid) {
    return { ok: true };
  }
  return {
    ok: false,
    status: 403,
    error: 'Not authorized to settle this call',
  };
}
