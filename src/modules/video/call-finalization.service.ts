import { Server } from 'socket.io';
import { Call, ICall } from './call.model';
import { getRedis, callEndingKey, CALL_ENDING_TTL } from '../../config/redis';
import {
  finalizeCallSession,
  isCallBillingAlreadySettled,
  enqueueImmediateSettlementRetry,
  type FinalizeResult,
  type SettlementSource,
} from '../billing/billing-session-finalization.service';
import { markDurableCallSessionEnding } from '../billing/call-session.service';
import { upsertPendingCallHistoryOnEnding } from '../billing/call-history-pending.service';
import { flushBillingPersistForCallId } from '../billing/billing-persist.service';
import { enqueueCallBillingProjectionEvent } from '../billing/call-history-projector.service';
import { isBillingOutboxProjectionEnabled } from '../billing/billing-phase-flags';
import { finalizeCreatorAvailabilityForCall, releaseCreatorCallLock } from './creator-call-lock.service';
import { transitionCallStatus } from './call-state.service';
import { clearCreatorActiveCallSlotIfStale } from '../availability/creator-active-call-slot.service';
import { transitionCreatorPresence } from '../availability/presence.service';
import { resolveBillingRuntimeState } from '../billing/billing-runtime-resolver.service';
import { logError, logInfo } from '../../utils/logger';
import { recordCallMetric } from '../../utils/monitoring';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { popNextQueuedCaller } from '../vip/vip-call-queue.service';

const FINALIZE_LOCK_TTL_SECONDS = 45;
const FINALIZE_DONE_TTL_SECONDS = 60 * 15;
const FINALIZER_MODE = (process.env.CALL_END_FINALIZER_MODE || 'enforce').toLowerCase();

const finalizeLockKey = (callId: string): string => `call:finalize:lock:${callId}`;
const finalizeDoneKey = (callId: string): string => `call:finalize:done:${callId}`;

type CallRecordLike = {
  creatorUserId: { toString(): string };
  status: string;
  isSettled?: boolean;
  save(): Promise<unknown>;
} | null;

function canUseTransitionCallStatus(call: Exclude<CallRecordLike, null>): call is ICall {
  return typeof (call as Partial<ICall>).callId === 'string';
}

let loadCallForFinalizationForTests: ((callId: string) => Promise<CallRecordLike>) | null = null;
let finalizeCallSessionForTests:
  | ((io: Server, params: { callId: string; reason: 'explicit_end'; source: any }) => Promise<unknown>)
  | null = null;
let releaseCreatorCallLockForTests: ((creatorUserId: string) => Promise<void>) | null = null;
let finalizeCreatorAvailabilityForCallForTests:
  | ((callId: string, creatorUserId: string) => Promise<void>)
  | null = null;

/**
 * Restore creator Redis/Socket presence after a call ends without running billing settlement.
 * Used when call:ended is deferred (session not ready) and by finalizeCallEnd dedupe repair.
 */
export async function restoreCreatorPresenceForEndedCall(
  io: Server,
  callId: string,
  source: string
): Promise<void> {
  const call = loadCallForFinalizationForTests
    ? await loadCallForFinalizationForTests(callId)
    : await Call.findOne({ callId });
  const releaseFn = releaseCreatorCallLockForTests ?? releaseCreatorCallLock;
  const finalizeAvailabilityFn =
    finalizeCreatorAvailabilityForCallForTests ?? finalizeCreatorAvailabilityForCall;

  if (call) {
    await releaseFn(call.creatorUserId.toString());
    await finalizeAvailabilityFn(callId, call.creatorUserId.toString());
    return;
  }

  const runtime = await resolveBillingRuntimeState(callId);
  const creatorFirebaseUid = runtime.session?.creatorFirebaseUid;
  if (!creatorFirebaseUid) {
    return;
  }

  await clearCreatorActiveCallSlotIfStale(creatorFirebaseUid, {
    endingCallId: callId,
    source: `call.finalizer.${source}.repair_no_call_record`,
  });
  await transitionCreatorPresence(
    io,
    creatorFirebaseUid,
    'CALL_ENDED',
    `call.finalizer.${source}.repair_no_call_record`
  );
}

export function setCallFinalizationHooksForTests(hooks: {
  loadCallForFinalization?: ((callId: string) => Promise<CallRecordLike>) | null;
  finalizeCallSession?: ((io: Server, params: { callId: string; reason: 'explicit_end'; source: any }) => Promise<unknown>) | null;
  releaseCreatorCallLock?: ((creatorUserId: string) => Promise<void>) | null;
  finalizeCreatorAvailabilityForCall?: ((callId: string, creatorUserId: string) => Promise<void>) | null;
}): void {
  loadCallForFinalizationForTests = hooks.loadCallForFinalization ?? null;
  finalizeCallSessionForTests = hooks.finalizeCallSession ?? null;
  releaseCreatorCallLockForTests = hooks.releaseCreatorCallLock ?? null;
  finalizeCreatorAvailabilityForCallForTests = hooks.finalizeCreatorAvailabilityForCall ?? null;
}

function mapCallEndSourceToSettlementSource(source: string): SettlementSource {
  if (source === 'http_settle_call') return 'http_call_ended';
  if (source === 'socket_call_ended') return 'socket_call_ended';
  if (source === 'force_end') return 'force_end';
  if (source === 'deferred_pending_end') return 'deferred_pending_end';
  if (source.startsWith('reconciliation')) return 'reconciliation_worker';
  if (source.startsWith('webhook')) return 'webhook';
  return 'webhook';
}

async function isFinalizeSettlementComplete(
  result: unknown,
  callId: string
): Promise<boolean> {
  if (!result || typeof result !== 'object' || !('status' in result)) {
    return false;
  }
  const status = (result as FinalizeResult).status;
  if (status === 'settled') {
    return true;
  }
  if (status === 'duplicate') {
    return isCallBillingAlreadySettled(callId);
  }
  if (status === 'pending_retry') {
    logInfo('call.finalize.pending_retry', { callId });
    return false;
  }
  return false;
}

/**
 * Mark a call as ending when billing session is not ready yet.
 * Prevents reconciliation from re-marking the creator busy while settlement is pending.
 */
export async function markCallEndingForDeferredEnd(callId: string, source: string): Promise<void> {
  const redis = getRedis();
  await redis.setex(
    callEndingKey(callId),
    CALL_ENDING_TTL,
    JSON.stringify({ markedAtMs: Date.now(), source })
  );

  const call = loadCallForFinalizationForTests
    ? await loadCallForFinalizationForTests(callId)
    : await Call.findOne({ callId });
  if (!call || call.status === 'ended') {
    return;
  }

  if (canUseTransitionCallStatus(call)) {
    transitionCallStatus(call, 'ended', {
      source: `call.deferred_end.${source}`,
      eventType: 'call_end_deferred',
    });
  } else {
    call.status = 'ended';
  }
  await call.save();
}

/**
 * When call:ended lands on a non-owner instance, restore presence and delegate settlement to retry.
 */
export async function delegateCallEndSettlementToRetry(
  io: Server,
  callId: string,
  source: string,
  settlementSource: SettlementSource
): Promise<void> {
  await markCallEndingForDeferredEnd(callId, source);

  const call = loadCallForFinalizationForTests
    ? await loadCallForFinalizationForTests(callId)
    : await Call.findOne({ callId });
  const releaseFn = releaseCreatorCallLockForTests ?? releaseCreatorCallLock;
  const finalizeAvailabilityFn =
    finalizeCreatorAvailabilityForCallForTests ?? finalizeCreatorAvailabilityForCall;

  if (call) {
    await releaseFn(call.creatorUserId.toString());
    await finalizeAvailabilityFn(callId, call.creatorUserId.toString());
  } else {
    await restoreCreatorPresenceForEndedCall(io, callId, `${source}.non_owner`);
  }

  await enqueueImmediateSettlementRetry({
    callId,
    reason: 'explicit_end',
    source: settlementSource,
  });
  recordCallMetric('call_ended_non_owner_retry_enqueued', 1, { callId, source });
  logInfo('Call end settlement delegated to retry queue', {
    callId,
    source,
    settlementSource,
  });
}

export async function finalizeCallEnd(
  io: Server,
  callId: string,
  source: string
): Promise<{ finalized: boolean; deduped: boolean }> {
  if (FINALIZER_MODE === 'log_only') {
    recordCallMetric('call.finalize.log_only', 1, { source });
    logInfo('Call finalizer running in log_only mode', { callId, source });
    return { finalized: false, deduped: false };
  }

  const redis = getRedis();
  const doneKey = finalizeDoneKey(callId);
  const lockKey = finalizeLockKey(callId);

  const alreadyDone = await redis.get(doneKey);
  if (alreadyDone) {
    recordCallMetric('call.finalize.deduped', 1, { source });
    try {
      await restoreCreatorPresenceForEndedCall(io, callId, source);
    } catch (repairErr) {
      logError('Call finalization dedupe presence repair failed', repairErr, { callId, source });
    }
    return { finalized: false, deduped: true };
  }

  const lockResult = await redis.set(lockKey, source, 'EX', FINALIZE_LOCK_TTL_SECONDS, 'NX');
  if (lockResult !== 'OK') {
    recordCallMetric('call.finalize.lock_busy', 1, { source });
    try {
      await restoreCreatorPresenceForEndedCall(io, callId, source);
    } catch (repairErr) {
      logError('Call finalization lock_busy presence repair failed', repairErr, { callId, source });
    }
    return { finalized: false, deduped: true };
  }

  try {
    const call = loadCallForFinalizationForTests
      ? await loadCallForFinalizationForTests(callId)
      : await Call.findOne({ callId });
    const settlementSource = mapCallEndSourceToSettlementSource(source);
    let settlementComplete = false;

    if (call) {
      // Restore creator availability ASAP so creators don’t appear “offline/busy”
      // for the entire settlement duration (which can be seconds).
      const releaseFn = releaseCreatorCallLockForTests ?? releaseCreatorCallLock;
      const finalizeAvailabilityFn =
        finalizeCreatorAvailabilityForCallForTests ?? finalizeCreatorAvailabilityForCall;
      await releaseFn(call.creatorUserId.toString());
      await finalizeAvailabilityFn(callId, call.creatorUserId.toString());

      if (call.status !== 'ended') {
        if (canUseTransitionCallStatus(call)) {
          transitionCallStatus(call, 'ended', {
            source: `call.finalizer.${source}`,
            eventType: 'call_end_finalize',
          });
        } else {
          // Test hooks may inject a lightweight call-like object without full ICall fields.
          call.status = 'ended';
        }
      }

      await flushBillingPersistForCallId(callId, 'call_end').catch(() => {});
      await markDurableCallSessionEnding(callId);
      const runtimeForPending = await resolveBillingRuntimeState(callId);
      if (isBillingOutboxProjectionEnabled() && runtimeForPending.session) {
        await enqueueCallBillingProjectionEvent({
          type: 'call.billing.ending',
          callId,
          payload: {
            userMongoId: runtimeForPending.session.userMongoId,
            creatorMongoId: runtimeForPending.session.creatorMongoId,
            userFirebaseUid: runtimeForPending.session.userFirebaseUid,
            creatorFirebaseUid: runtimeForPending.session.creatorFirebaseUid,
            durationSeconds: runtimeForPending.session.elapsedSeconds ?? 0,
          },
        });
      } else {
        await upsertPendingCallHistoryOnEnding({
          callId,
          redisSession: runtimeForPending.session as import('../billing/billing.service').CallSession | null,
        });
      }

      const finalizeSessionFn = finalizeCallSessionForTests ?? finalizeCallSession;
      const finalizeResult = await finalizeSessionFn(io, {
        callId,
        reason: 'explicit_end',
        source: settlementSource,
      });
      settlementComplete = await isFinalizeSettlementComplete(finalizeResult, callId);
      if (
        finalizeResult &&
        typeof finalizeResult === 'object' &&
        'status' in finalizeResult &&
        (finalizeResult as FinalizeResult).status === 'duplicate' &&
        !settlementComplete
      ) {
        recordCallMetric('call_finalize_false_success_prevented', 1, { callId, source });
      }
      if (settlementComplete) {
        call.isSettled = true;
      }
      await call.save();
    } else {
      await flushBillingPersistForCallId(callId, 'call_end').catch(() => {});
      const finalizeSessionFn = finalizeCallSessionForTests ?? finalizeCallSession;
      const finalizeResult = await finalizeSessionFn(io, {
        callId,
        reason: 'explicit_end',
        source: settlementSource,
      });
      settlementComplete = await isFinalizeSettlementComplete(finalizeResult, callId);
    }

    if (settlementComplete) {
      await redis.set(doneKey, source, 'EX', FINALIZE_DONE_TTL_SECONDS);
      recordCallMetric('call.finalize.success', 1, { source });
      logInfo('Call finalization completed', { callId, source, hasCallRecord: !!call });
    } else {
      logInfo('Call finalization pending settlement retry', { callId, source, hasCallRecord: !!call });
    }

    if (call?.creatorUserId && settlementComplete) {
      try {
        const creatorUser = await User.findById(call.creatorUserId)
          .select('firebaseUid')
          .lean();
        if (creatorUser?.firebaseUid) {
          const next = await popNextQueuedCaller(creatorUser.firebaseUid);
          if (next) {
            const creator = await Creator.findOne({ userId: call.creatorUserId })
              .select('_id')
              .lean();
            io.to(`user:${next.callerFirebaseUid}`).emit('vip:call:ready_to_ring', {
              creatorFirebaseUid: creatorUser.firebaseUid,
              creatorId: creator?._id?.toString(),
              entryId: next.entryId,
            });
          }
        }
      } catch (queueErr) {
        logError('vip_queue_dequeue_failed', queueErr, { callId, source });
      }
    }

    return { finalized: settlementComplete, deduped: false };
  } catch (error) {
    recordCallMetric('call.finalize.error', 1, { source });
    logError('Call finalization failed', error, { callId, source });
    throw error;
  } finally {
    await redis.del(lockKey).catch(() => {});
  }
}
