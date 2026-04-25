import { Server } from 'socket.io';
import { Call } from './call.model';
import { getRedis } from '../../config/redis';
import { settleCall } from '../billing/billing-settlement.service';
import { finalizeCreatorAvailabilityForCall, releaseCreatorCallLock } from './creator-call-lock.service';
import { transitionCallStatus } from './call-state.service';
import { logError, logInfo } from '../../utils/logger';
import { recordCallMetric } from '../../utils/monitoring';

const FINALIZE_LOCK_TTL_SECONDS = 45;
const FINALIZE_DONE_TTL_SECONDS = 60 * 15;
const FINALIZER_MODE = (process.env.CALL_END_FINALIZER_MODE || 'enforce').toLowerCase();

const finalizeLockKey = (callId: string): string => `call:finalize:lock:${callId}`;
const finalizeDoneKey = (callId: string): string => `call:finalize:done:${callId}`;

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
    return { finalized: false, deduped: true };
  }

  const lockResult = await redis.set(lockKey, source, 'EX', FINALIZE_LOCK_TTL_SECONDS, 'NX');
  if (lockResult !== 'OK') {
    recordCallMetric('call.finalize.lock_busy', 1, { source });
    return { finalized: false, deduped: true };
  }

  try {
    await settleCall(io, callId);

    const call = await Call.findOne({ callId });
    if (call) {
      if (call.status !== 'ended') {
        transitionCallStatus(call, 'ended', {
          source: `call.finalizer.${source}`,
          eventType: 'call_end_finalize',
        });
      }
      if (!call.isSettled) {
        call.isSettled = true;
      }

      await releaseCreatorCallLock(call.creatorUserId.toString());
      await finalizeCreatorAvailabilityForCall(callId, call.creatorUserId.toString());
      await call.save();
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
