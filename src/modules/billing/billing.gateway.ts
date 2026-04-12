import { Server } from 'socket.io';
import {
  getRedis,
  callSessionKey,
  ACTIVE_BILLING_CALLS_KEY,
  pendingCallEndKey,
  PENDING_CALL_END_TTL,
} from '../../config/redis';
import { billingService, type BillingSessionStartSource } from './billing.service';
import { settleCall } from './billing-settlement.service';
import { logInfo, logDebug } from '../../utils/logger';
import { isBullmqBillingEnabled, closeBillingBullMq } from './billing.queue';
import { setupBillingGateway } from './billing-socket.gateway';
import {
  startGlobalBillingProcessor,
  stopGlobalBillingProcessor,
} from './billing-batch.processor';

export { setupBillingGateway, startGlobalBillingProcessor, stopGlobalBillingProcessor };

async function handleCallStarted(
  io: Server,
  userFirebaseUid: string,
  data: {
    callId: string;
    creatorFirebaseUid: string;
    creatorMongoId: string;
  },
  opts?: { source?: BillingSessionStartSource }
): Promise<void> {
  await billingService.startBillingSession(io, userFirebaseUid, data, opts);

  logDebug('Call started via handleCallStarted', {
    callId: data.callId,
    source: opts?.source,
  });
}

/**
 * HTTP-invocable version of handleCallStarted.
 * Used by the REST API fallback when the client's Socket.IO is not connected.
 */
export async function handleCallStartedHttp(
  io: Server,
  userFirebaseUid: string,
  data: { callId: string; creatorFirebaseUid: string; creatorMongoId: string },
  opts?: { source?: BillingSessionStartSource }
): Promise<void> {
  logInfo('handleCallStartedHttp', {
    callId: data.callId,
    userFirebaseUid,
    source: opts?.source,
  });
  await handleCallStarted(io, userFirebaseUid, data, opts);

  const redis = getRedis();
  const pendingEndKey = pendingCallEndKey(data.callId);
  const hasPendingEnd = await redis.get(pendingEndKey);
  if (hasPendingEnd) {
    await redis.del(pendingEndKey);
    logInfo('Deferred settlement (HTTP)', { callId: data.callId });
    await settleCall(io, data.callId);
  }
}

/**
 * HTTP-invocable version of settleCall.
 * Used by the REST API fallback when the client's Socket.IO is not connected.
 */
export async function settleCallHttp(io: Server, callId: string): Promise<void> {
  logInfo('settleCallHttp', { callId });

  const redis = getRedis();
  const sessionExists = await redis.get(callSessionKey(callId));

  const isInActiveBilling = await redis.zscore(ACTIVE_BILLING_CALLS_KEY, callId);

  if (!sessionExists && !isInActiveBilling) {
    await redis.setex(pendingCallEndKey(callId), PENDING_CALL_END_TTL, '1');
    logInfo('Deferring call:ended (HTTP, session not ready)', { callId });
    return;
  }

  await settleCall(io, callId);
}

export async function cleanupBillingIntervals(): Promise<void> {
  stopGlobalBillingProcessor();
  if (isBullmqBillingEnabled()) {
    await closeBillingBullMq().catch(() => {});
  }
  logInfo('Cleaned up billing system', {});
}
