/**
 * Guards for duplicate settlement triggers (billing queue vs forceTerminateCall).
 */

import {
  getRedis,
  finalizeInflightKey,
  billingSettlementRequestedKey,
  SETTLEMENT_CLAIM_TTL_SECONDS,
} from '../../config/redis';
import { Call } from '../video/call.model';

const CALL_FINALIZE_LOCK_PREFIX = 'call:finalize:lock:';
const CALL_FINALIZE_DONE_PREFIX = 'call:finalize:done:';

export async function tryClaimSettlementRequested(callId: string): Promise<boolean> {
  const redis = getRedis();
  const result = await redis.set(
    billingSettlementRequestedKey(callId),
    '1',
    'EX',
    SETTLEMENT_CLAIM_TTL_SECONDS,
    'NX'
  );
  return result === 'OK';
}

export async function isSettlementAlreadyTriggered(callId: string): Promise<boolean> {
  const redis = getRedis();
  const [inflight, lock, done, requested] = await Promise.all([
    redis.get(finalizeInflightKey(callId)),
    redis.get(`${CALL_FINALIZE_LOCK_PREFIX}${callId}`),
    redis.get(`${CALL_FINALIZE_DONE_PREFIX}${callId}`),
    redis.get(billingSettlementRequestedKey(callId)),
  ]);
  if (inflight || lock || done || requested) {
    return true;
  }
  const call = await Call.findOne({ callId }).select('settlement.status').lean();
  return call?.settlement?.status === 'settling';
}
