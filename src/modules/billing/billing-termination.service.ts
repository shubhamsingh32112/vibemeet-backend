import { Server } from 'socket.io';
import { recordBillingMetric } from '../../utils/monitoring';
import { logError, logInfo, logWarning } from '../../utils/logger';
import {
  hasCallEndedMarker,
  releaseMarkEndedLease,
  setCallEndedMarker,
  tryAcquireMarkEndedLease,
} from './billing-termination.state';
import { markStreamCallEnded } from './billing-termination.stream';
import { enqueueTerminationRetryJob } from './billing-termination.queue';
import { enqueueTerminationRedisRetry } from './billing-termination-redis-retry';
import { isBullmqBillingEnabled } from './billing-driver';

type ForceTerminationReason =
  | 'insufficient_coins'
  | 'user_out_of_coins'
  | 'duration_limit_reached'
  | 'intro_promo_exhausted'
  | 'min_coins_not_met'
  | 'unknown';

interface ForceTerminateParams {
  callId: string;
  userFirebaseUid: string;
  creatorFirebaseUid: string;
  reason: ForceTerminationReason;
  creatorReason?: ForceTerminationReason;
  userPayload?: Record<string, unknown>;
  creatorPayload?: Record<string, unknown>;
}

function isServerForceEndEnabled(): boolean {
  return process.env.BILLING_SERVER_FORCE_END_ENABLED !== 'false';
}

export async function forceTerminateCall(
  io: Server,
  params: ForceTerminateParams
): Promise<void> {
  const {
    callId,
    userFirebaseUid,
    creatorFirebaseUid,
    reason,
    creatorReason,
    userPayload,
    creatorPayload,
  } = params;

  recordBillingMetric('force_terminate_requested', 1, { callId, reason });

  io.to(`user:${userFirebaseUid}`).emit('call:force-end', {
    callId,
    reason,
    ...(userPayload || {}),
  });
  io.to(`user:${creatorFirebaseUid}`).emit('call:force-end', {
    callId,
    reason: creatorReason || reason,
    ...(creatorPayload || {}),
  });

  if (!isServerForceEndEnabled()) {
    recordBillingMetric('force_terminate_server_disabled', 1, { callId, reason });
    return;
  }

  if (await hasCallEndedMarker(callId)) {
    recordBillingMetric('force_terminate_deduped', 1, { callId, reason });
    return;
  }

  const acquired = await tryAcquireMarkEndedLease(callId);
  if (!acquired) {
    recordBillingMetric('force_terminate_deduped', 1, { callId, reason });
    return;
  }

  const { finalizeCallEnd } = await import('../video/call-finalization.service');
  void finalizeCallEnd(io, callId, 'force_end').catch((finalizeError) => {
    logError('forceTerminateCall finalization trigger failed', finalizeError, { callId, reason });
  });
  recordBillingMetric('force_terminate_settlement_triggered', 1, { callId, reason });

  try {
    const streamResult = await markStreamCallEnded(callId, reason);
    await setCallEndedMarker(callId);
    await releaseMarkEndedLease(callId);
    recordBillingMetric('force_terminate_stream_success', 1, {
      callId,
      reason,
      streamResult: streamResult.outcome,
    });
    if (streamResult.outcome === 'not_found') {
      logInfo('Server-side Stream mark_ended treated as idempotent not_found', {
        callId,
        reason,
      });
    } else {
      logInfo('Server-side Stream mark_ended sent', { callId, reason });
    }
  } catch (error) {
    await releaseMarkEndedLease(callId);
    recordBillingMetric('force_terminate_stream_failed', 1, { callId, reason });
    logWarning('Server-side Stream mark_ended failed; settlement will continue', {
      callId,
      reason,
    });
    logError('Stream mark_ended error', error, { callId, reason });
    if (isBullmqBillingEnabled()) {
      await enqueueTerminationRetryJob({
        callId,
        userFirebaseUid,
        creatorFirebaseUid,
        reason,
      }).catch((enqueueError) => {
        logError('Failed to enqueue termination retry', enqueueError, { callId, reason });
      });
    } else {
      await enqueueTerminationRedisRetry({
        callId,
        userFirebaseUid,
        creatorFirebaseUid,
        reason,
      }).catch((enqueueError) => {
        logError('Failed to enqueue termination redis retry', enqueueError, { callId, reason });
      });
    }
  }
}
