import { Server } from 'socket.io';
import { randomUUID } from 'crypto';
import {
  getRedis,
  callSessionKey,
  pendingCallEndKey,
  PENDING_CALL_END_TTL,
} from '../../config/redis';
import { billingService, type BillingSessionStartSource, waitForBillingSessionReady } from './billing.service';
import { assertNotShuttingDown } from './billing-shutdown.service';
import { logInfo, logDebug, logError } from '../../utils/logger';
import { recordBillingMetric } from '../../utils/monitoring';
import { isBullmqBillingEnabled, closeBillingBullMq } from './billing.queue';
import { closeTerminationRetryQueue } from './billing-termination.queue';
import { isCallActive, isNonTerminalLifecycle } from './billing-active-call.service';
import { setupBillingGateway } from './billing-socket.gateway';
import {
  finalizeCallEnd,
  restoreCreatorPresenceForEndedCall,
  markCallEndingForDeferredEnd,
  delegateCallEndSettlementToRetry,
} from '../video/call-finalization.service';
import { billingInstanceIdsMatch, getBillingInstanceId } from './billing-instance-id';
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
    startCorrelationId?: string;
    startIngress?: 'socket' | 'http' | 'webhook' | 'system';
  }
): Promise<void> {
  assertNotShuttingDown('billing.start');
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
    startCorrelationId?: string;
    startIngress?: 'socket' | 'http' | 'webhook' | 'system';
  }
): Promise<void> {
  const resolvedSource = opts?.source ?? 'client_http';
  const startCorrelationId = opts?.startCorrelationId || randomUUID();
  logInfo('handleCallStartedHttp', {
    callId: data.callId,
    userFirebaseUid,
    source: resolvedSource,
    startCorrelationId,
    startIngress: opts?.startIngress ?? 'http',
    initiatedByFirebaseUid: opts?.initiatedByFirebaseUid,
    initiatedByRole: opts?.initiatedByRole,
    creatorFirebaseUid: data.creatorFirebaseUid,
  });
  await handleCallStarted(io, userFirebaseUid, data, {
    ...opts,
    startCorrelationId,
    startIngress: opts?.startIngress ?? 'http',
  });
}

/**
 * HTTP-invocable version of settleCall.
 * Used by the REST API fallback when the client's Socket.IO is not connected.
 */
export async function settleCallHttp(io: Server, callId: string): Promise<void> {
  logInfo('settleCallHttp', { callId });

  const redis = getRedis();
  let sessionRaw = await redis.get(callSessionKey(callId));
  if (!sessionRaw) {
    const waited = await waitForBillingSessionReady(callId, { timeoutMs: 2000 });
    if (waited) {
      sessionRaw = JSON.stringify(waited);
    }
  }
  let userFirebaseUid: string | undefined;
  let creatorFirebaseUid: string | undefined;
  let sessionInstanceId: string | undefined;
  let sessionLifecycle: string | undefined;
  if (sessionRaw) {
    try {
      const session = JSON.parse(sessionRaw) as {
        userFirebaseUid?: string;
        creatorFirebaseUid?: string;
        instanceId?: string;
        lifecycleState?: string;
      };
      userFirebaseUid = session.userFirebaseUid;
      creatorFirebaseUid = session.creatorFirebaseUid;
      sessionInstanceId = session.instanceId;
      sessionLifecycle = session.lifecycleState;
    } catch {
      // Ignore parse failures; helper still checks call session existence.
    }
  }

  const active = await isCallActive(redis, {
    callId,
    userFirebaseUid,
    creatorFirebaseUid,
  });

  if (!active) {
    await markCallEndingForDeferredEnd(callId, 'http_settle_call');
    await redis.setex(
      pendingCallEndKey(callId),
      PENDING_CALL_END_TTL,
      JSON.stringify({
        requestedAtMs: Date.now(),
        source: 'http_settle_call',
      })
    );
    logInfo('Deferring call:ended (HTTP, session not ready)', {
      callId,
      source: 'http_settle_call',
    });
    recordBillingMetric('deferred_call_end_queued', 1, {
      callId,
      source: 'http_settle_call',
    });
    try {
      await restoreCreatorPresenceForEndedCall(io, callId, 'http_settle_call.deferred_presence');
    } catch (presenceErr) {
      logError('Deferred HTTP call-ended presence restore failed', presenceErr, { callId });
    }
    return;
  }

  const workerInstanceId = getBillingInstanceId();
  if (
    sessionInstanceId &&
    sessionLifecycle &&
    isNonTerminalLifecycle(sessionLifecycle) &&
    !billingInstanceIdsMatch(sessionInstanceId, workerInstanceId)
  ) {
    await delegateCallEndSettlementToRetry(io, callId, 'http_settle_call', 'http_call_ended');
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
