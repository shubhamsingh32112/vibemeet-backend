import { getRedis, callSessionKey, isRedisConfigured } from '../../config/redis';
import { parseAppVideoCallId } from './billing-call-id.util';

export type BillingRestDeny = { ok: false; status: number; error: string };
export type BillingRestAllow = { ok: true };
export type BillingRestCallStartedResult =
  | BillingRestDeny
  | { ok: true; payerFirebaseUid: string };

/**
 * HTTP billing start: the payer is `userFirebaseUid` in the body when the creator
 * initiates billing on behalf of the user; otherwise the authenticated user pays.
 * Matches socket: `payer = data.userFirebaseUid || socket.firebaseUid`
 */
export function assertBillingRestCallStartedAccess(
  firebaseUid: string,
  callId: string,
  creatorFirebaseUid: string,
  creatorMongoId: string,
  userFirebaseUid?: string | null
): BillingRestCallStartedResult {
  const parsed = parseAppVideoCallId(callId);
  if (!parsed) {
    return { ok: false, status: 400, error: 'Invalid callId format' };
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

  const hasExplicitPayer = !!userFirebaseUid && String(userFirebaseUid).trim().length > 0;
  const payerFirebaseUid = hasExplicitPayer ? String(userFirebaseUid).trim() : firebaseUid;

  if (payerFirebaseUid === creatorFirebaseUid) {
    return { ok: false, status: 400, error: 'Payer cannot be the same as the creator' };
  }

  const initiator = parsed.initiatorFirebaseUid;
  const auth = firebaseUid;

  if (auth === creatorFirebaseUid) {
    if (initiator !== creatorFirebaseUid) {
      return { ok: false, status: 400, error: 'callId is not a creator-originated call' };
    }
    if (!hasExplicitPayer) {
      return {
        ok: false,
        status: 400,
        error: 'userFirebaseUid is required when the creator starts billing (HTTP)',
      };
    }
    if (payerFirebaseUid === auth) {
      return { ok: false, status: 400, error: 'Payer must be the fan, not the creator' };
    }
    return { ok: true, payerFirebaseUid };
  }

  if (auth === payerFirebaseUid) {
    if (initiator === auth) {
      return { ok: true, payerFirebaseUid };
    }
    if (initiator === creatorFirebaseUid && auth !== creatorFirebaseUid) {
      return { ok: true, payerFirebaseUid };
    }
    return { ok: false, status: 403, error: 'callId does not match this billing request' };
  }

  return { ok: false, status: 403, error: 'Not authorized to start billing for this call' };
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
    if (parsed && parsed.initiatorFirebaseUid === firebaseUid) {
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
  if (parsed && parsed.initiatorFirebaseUid === firebaseUid) {
    return { ok: true };
  }
  return {
    ok: false,
    status: 403,
    error: 'Not authorized to settle this call',
  };
}
