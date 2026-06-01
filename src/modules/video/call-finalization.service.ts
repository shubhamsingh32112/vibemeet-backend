import { Server } from 'socket.io';
import { Call, ICall } from './call.model';
import { getRedis } from '../../config/redis';
import { finalizeCallSession } from '../billing/billing-session-finalization.service';
import { finalizeCreatorAvailabilityForCall, releaseCreatorCallLock } from './creator-call-lock.service';
import { transitionCallStatus } from './call-state.service';
import { clearCreatorActiveCallSlotIfStale } from '../availability/creator-active-call-slot.service';
import { transitionCreatorPresence } from '../availability/presence.service';
import { resolveBillingRuntimeState } from '../billing/billing-runtime-resolver.service';
import { logError, logInfo } from '../../utils/logger';
import { recordCallMetric } from '../../utils/monitoring';

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
      if (!call.isSettled) {
        call.isSettled = true;
      }

      const settlementSource =
        source === 'http_settle_call'
          ? 'http_call_ended'
          : source === 'socket_call_ended'
            ? 'socket_call_ended'
            : source === 'force_end'
              ? 'force_end'
              : source === 'deferred_pending_end'
                ? 'deferred_pending_end'
            : source.startsWith('reconciliation')
              ? 'reconciliation_worker'
              : source.startsWith('webhook')
                ? 'webhook'
                : 'webhook';

      const finalizeSessionFn = finalizeCallSessionForTests ?? finalizeCallSession;
      await finalizeSessionFn(io, {
        callId,
        reason: 'explicit_end',
        source: settlementSource,
      });
      await call.save();
    } else {
      const finalizeSessionFn = finalizeCallSessionForTests ?? finalizeCallSession;
      await finalizeSessionFn(io, {
        callId,
        reason: 'explicit_end',
        source: 'webhook',
      });
    }

    await redis.set(doneKey, source, 'EX', FINALIZE_DONE_TTL_SECONDS);
    recordCallMetric('call.finalize.success', 1, { source });
    logInfo('Call finalization completed', { callId, source, hasCallRecord: !!call });
    return { finalized: true, deduped: false };
  } catch (error) {
    recordCallMetric('call.finalize.error', 1, { source });
    logError('Call finalization failed', error, { callId, source });
    throw error;
  } finally {
    await redis.del(lockKey).catch(() => {});
  }
}
