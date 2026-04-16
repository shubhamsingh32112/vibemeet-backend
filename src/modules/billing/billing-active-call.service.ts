import { Redis } from 'ioredis';
import {
  ACTIVE_BILLING_CALLS_KEY,
  activeCallByUserKey,
  callSessionKey,
} from '../../config/redis';

interface ActiveCallCheckParams {
  callId: string;
  userFirebaseUid?: string;
  creatorFirebaseUid?: string;
  includeLegacySchedulerCheck?: boolean;
}

export async function isCallActive(
  redis: Redis,
  params: ActiveCallCheckParams
): Promise<boolean> {
  const { callId, userFirebaseUid, creatorFirebaseUid, includeLegacySchedulerCheck } = params;

  const sessionRaw = await redis.get(callSessionKey(callId));
  if (sessionRaw) {
    return true;
  }

  const userChecks: Array<Promise<string | null>> = [];
  if (userFirebaseUid) {
    userChecks.push(redis.get(activeCallByUserKey(userFirebaseUid)));
  }
  if (creatorFirebaseUid) {
    userChecks.push(redis.get(activeCallByUserKey(creatorFirebaseUid)));
  }

  if (userChecks.length > 0) {
    const userMappedCalls = await Promise.all(userChecks);
    if (userMappedCalls.some((mappedCallId) => mappedCallId === callId)) {
      return true;
    }
  }

  if (includeLegacySchedulerCheck) {
    const inScheduler = await redis.zscore(ACTIVE_BILLING_CALLS_KEY, callId);
    if (inScheduler) {
      return true;
    }
  }

  return false;
}
