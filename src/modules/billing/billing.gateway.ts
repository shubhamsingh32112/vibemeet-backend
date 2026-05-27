import { Server } from 'socket.io';
import {
  getRedis,
  callSessionKey,
  pendingCallEndKey,
  PENDING_CALL_END_TTL,
} from '../../config/redis';
import { billingService, type BillingSessionStartSource } from './billing.service';
import { finalizeCallSession } from './billing-session-finalization.service';
import { logInfo, logDebug } from '../../utils/logger';
import { isBullmqBillingEnabled, closeBillingBullMq } from './billing.queue';
import { closeTerminationRetryQueue } from './billing-termination.queue';
import { isCallActive } from './billing-active-call.service';
import { setupBillingGateway } from './billing-socket.gateway';
import { finalizeCallEnd } from '../video/call-finalization.service';
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
  opts?: {
    source?: BillingSessionStartSource;
    requestReceivedAtMs?: number;
    initiatedByFirebaseUid?: string;
    initiatedByRole?: 'user' | 'creator' | 'admin';
  }
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
  opts?: {
    source?: BillingSessionStartSource;
    requestReceivedAtMs?: number;
    initiatedByFirebaseUid?: string;
    initiatedByRole?: 'user' | 'creator' | 'admin';
  }
): Promise<void> {
  const resolvedSource = opts?.source ?? 'client_http';
  logInfo('handleCallStartedHttp', {
    callId: data.callId,
    userFirebaseUid,
    source: resolvedSource,
    initiatedByFirebaseUid: opts?.initiatedByFirebaseUid,
    initiatedByRole: opts?.initiatedByRole,
    creatorFirebaseUid: data.creatorFirebaseUid,
  });
  logInfo('billing_lifecycle_start_received', {
    callId: data.callId,
    source: resolvedSource,
    initiatedByFirebaseUid: opts?.initiatedByFirebaseUid,
    initiatedByRole: opts?.initiatedByRole,
    payerFirebaseUid: userFirebaseUid,
    creatorFirebaseUid: data.creatorFirebaseUid,
  });
  await handleCallStarted(io, userFirebaseUid, data, opts);

  const redis = getRedis();
  const pendingEndKey = pendingCallEndKey(data.callId);
  const hasPendingEnd = await redis.get(pendingEndKey);
  if (hasPendingEnd) {
    await redis.del(pendingEndKey);
    logInfo('Deferred settlement (HTTP)', { callId: data.callId });
    await finalizeCallSession(io, {
      callId: data.callId,
      reason: 'explicit_end',
      source: 'deferred_pending_end',
    });
  }
}

/**
 * HTTP-invocable version of settleCall.
 * Used by the REST API fallback when the client's Socket.IO is not connected.
 */
export async function settleCallHttp(io: Server, callId: string): Promise<void> {
  logInfo('settleCallHttp', { callId });

  const redis = getRedis();
  const sessionRaw = await redis.get(callSessionKey(callId));
  let userFirebaseUid: string | undefined;
  let creatorFirebaseUid: string | undefined;
  if (sessionRaw) {
    try {
      const session = JSON.parse(sessionRaw) as {
        userFirebaseUid?: string;
        creatorFirebaseUid?: string;
      };
      userFirebaseUid = session.userFirebaseUid;
      creatorFirebaseUid = session.creatorFirebaseUid;
    } catch {
      // Ignore parse failures; helper still checks call session existence.
    }
  }

  const active = await isCallActive(redis, {
    callId,
    userFirebaseUid,
    creatorFirebaseUid,
    includeLegacySchedulerCheck: !isBullmqBillingEnabled(),
  });

  if (!active) {
    await redis.setex(pendingCallEndKey(callId), PENDING_CALL_END_TTL, '1');
    logInfo('Deferring call:ended (HTTP, session not ready)', { callId });
    return;
  }

  await finalizeCallEnd(io, callId, 'http_settle_call');
}

export async function cleanupBillingIntervals(): Promise<void> {
  stopGlobalBillingProcessor();
  await closeTerminationRetryQueue().catch(() => {});
  if (isBullmqBillingEnabled()) {
    await closeBillingBullMq().catch(() => {});
  }
  logInfo('Cleaned up billing system', {});
}
