import { Creator } from '../creator/creator.model';
import { User } from '../user/user.model';
import { getStreamClient } from '../../config/stream';
import { getAvailability, type CreatorAvailability } from '../availability/availability.service';
import { getRedis, activeCallByUserKey } from '../../config/redis';
import { logError, logInfo } from '../../utils/logger';
import { recordCallMetric } from '../../utils/monitoring';
import { getIO } from '../../config/socket';
import { transitionCreatorPresence } from '../availability/presence.service';
import { featureFlags } from '../../config/feature-flags';

/**
 * Centralised helper for creator call locking and availability updates.
 *
 * All writes to:
 * - Creator.currentCallId
 * - Creator.isOnline (as it relates to video calls)
 * - Redis availability + Socket.IO presence
 * - Stream Chat "busy" flag
 *
 * should go through this module so invariants like
 * "a creator cannot be in two active calls" remain easy to reason about.
 */

export async function acquireCreatorCallLock(
  creatorUserId: string,
  callId: string
): Promise<void> {
  try {
    const creator = await Creator.findOne({ userId: creatorUserId });
    if (!creator) {
      logError(
        'Failed to acquire creator call lock — creator not found',
        new Error('Creator missing'),
        { creatorUserId, callId }
      );
      return;
    }

    // Lock the creator to this call and mark them as not generically online.
    creator.currentCallId = callId;
    creator.isOnline = false;
    await creator.save();

    const creatorUser = await User.findById(creator.userId);
    if (!creatorUser?.firebaseUid) {
      logInfo('Creator user found but has no firebaseUid; skipping presence updates', {
        creatorUserId,
        callId,
      });
      return;
    }

    const creatorFirebaseUid = creatorUser.firebaseUid;

    // Backend-authoritative availability: mark busy in Redis + Socket.IO.
    await transitionCreatorPresence(
      getIO(),
      creatorFirebaseUid,
      'CALL_STARTED',
      'creator-call-lock.acquireCreatorCallLock'
    );

    // Legacy Stream Chat presence (kept for backwards compatibility).
    const streamClient = getStreamClient();
    await streamClient.partialUpdateUser({
      id: creatorFirebaseUid,
      set: {
        busy: true,
      },
    });

    logInfo('Creator call lock acquired', {
      creatorUserId,
      callId,
      firebaseUid: creatorFirebaseUid,
    });
  } catch (error) {
    logError('Error acquiring creator call lock', error, { creatorUserId, callId });
  }
}

const PRECALL_SNAPSHOT_PREFIX = 'call:precall:availability:';
const PRECALL_SNAPSHOT_TTL_SECONDS = 60 * 60 * 2;
const ORCHESTRATOR_MODE = (process.env.CREATOR_AVAILABILITY_ORCHESTRATOR_MODE || 'enforce').toLowerCase();

const shouldEnforceAvailabilityWrites = (): boolean => ORCHESTRATOR_MODE !== 'log_only';

const lifecycleDedupeKey = (callId: string, phase: string): string =>
  `call:lifecycle:creator:${callId}:${phase}`;

const precallSnapshotKey = (callId: string, creatorFirebaseUid: string): string =>
  `${PRECALL_SNAPSHOT_PREFIX}${callId}:${creatorFirebaseUid}`;

export async function snapshotPreCallAvailability(
  callId: string,
  creatorFirebaseUid: string
): Promise<void> {
  try {
    const redis = getRedis();
    const currentStatus = await getAvailability(creatorFirebaseUid);
    const result = await redis.set(
      precallSnapshotKey(callId, creatorFirebaseUid),
      currentStatus,
      'EX',
      PRECALL_SNAPSHOT_TTL_SECONDS,
      'NX'
    );
    logInfo('Pre-call availability snapshot processed', {
      callId,
      creatorFirebaseUid,
      status: currentStatus,
      saved: result === 'OK',
    });
    recordCallMetric(result === 'OK' ? 'creator.snapshot.saved' : 'creator.snapshot.duplicate', 1, {
      callId,
    });
  } catch (error) {
    logError('Failed to snapshot pre-call availability', error, {
      callId,
      creatorFirebaseUid,
    });
    recordCallMetric('creator.snapshot.error', 1, { callId });
  }
}

export async function markCreatorBusyForCall(
  callId: string,
  creatorFirebaseUid: string,
  phase: 'ringing' | 'accepted' | 'session_started'
): Promise<void> {
  try {
    const redis = getRedis();
    const dedupeResult = await redis.set(
      lifecycleDedupeKey(callId, phase),
      '1',
      'EX',
      PRECALL_SNAPSHOT_TTL_SECONDS,
      'NX'
    );
    if (dedupeResult !== 'OK') {
      logInfo('Skipping duplicate creator busy lifecycle phase', {
        callId,
        creatorFirebaseUid,
        phase,
      });
      recordCallMetric('creator.busy.duplicate_phase', 1, { callId, phase });
      return;
    }

    await snapshotPreCallAvailability(callId, creatorFirebaseUid);
    await redis.set(activeCallByUserKey(creatorFirebaseUid), callId, 'EX', PRECALL_SNAPSHOT_TTL_SECONDS);

    const current = await getAvailability(creatorFirebaseUid);
    if (shouldEnforceAvailabilityWrites() && (featureFlags.creatorPresenceUserModelEnabled || current !== 'busy')) {
      await transitionCreatorPresence(
        getIO(),
        creatorFirebaseUid,
        'CALL_STARTED',
        `creator-call-lock.markCreatorBusyForCall:${phase}`
      );
      recordCallMetric('creator.busy.set', 1, { callId, phase });
    }

    if (shouldEnforceAvailabilityWrites()) {
      try {
        const streamClient = getStreamClient();
        await streamClient.partialUpdateUser({
          id: creatorFirebaseUid,
          set: { busy: true },
        });
      } catch (streamError) {
        logError('Failed to set Stream Chat busy state (non-critical)', streamError, {
          callId,
          creatorFirebaseUid,
          phase,
        });
      }
    }

    logInfo('Creator marked busy for call lifecycle phase', {
      callId,
      creatorFirebaseUid,
      phase,
      mode: ORCHESTRATOR_MODE,
    });
  } catch (error) {
    logError('Failed to mark creator busy for call', error, {
      callId,
      creatorFirebaseUid,
      phase,
    });
  }
}

/**
 * Release the creator's call lock by user ID.
 * Does not change availability — use `updateCreatorAvailabilityAfterCall` for that.
 */
export async function releaseCreatorCallLock(creatorUserId: string): Promise<void> {
  try {
    const creator = await Creator.findOne({ userId: creatorUserId });
    if (creator) {
      creator.currentCallId = undefined;
      await creator.save();
      logInfo('Released creator call lock', { creatorUserId });
    }
  } catch (error) {
    logError('Error releasing creator call lock', error, { creatorUserId });
  }
}

/**
 * Update creator availability after a call ends.
 *
 * Behaviour:
 * - Reads the creator's profile to determine whether their toggle is ON (isOnline).
 * - If toggle is ON → mark Redis + sockets "online".
 * - If toggle is OFF → keep them "busy" until they explicitly go online again.
 * - Always clears Stream Chat "busy" flag.
 */
export async function updateCreatorAvailabilityAfterCall(
  creatorUserId: string
): Promise<void> {
  try {
    const creator = await Creator.findOne({ userId: creatorUserId });
    if (!creator) {
      logError(
        'Cannot update availability after call — creator not found',
        new Error('Creator missing'),
        { creatorUserId }
      );
      return;
    }

    const creatorUser = await User.findById(creator.userId);
    if (!creatorUser?.firebaseUid) {
      logInfo('Creator user has no firebaseUid; skipping availability broadcast', {
        creatorUserId,
      });
      return;
    }

    const creatorFirebaseUid = creatorUser.firebaseUid;

    const isAvailableToggleOn = creator.isOnline === true;
    const newStatus = isAvailableToggleOn ? 'online' : 'busy';

    const restoreEvent =
      newStatus === 'online'
        ? featureFlags.creatorPresenceUserModelEnabled
          ? 'CONNECTED'
          : 'CALL_ENDED'
        : 'DISCONNECTED';
    await transitionCreatorPresence(
      getIO(),
      creatorFirebaseUid,
      restoreEvent,
      'creator-call-lock.updateCreatorAvailabilityAfterCall'
    );

    const streamClient = getStreamClient();
    await streamClient.partialUpdateUser({
      id: creatorFirebaseUid,
      set: {
        busy: false,
      },
    });

    logInfo('Creator availability updated after call', {
      creatorUserId,
      firebaseUid: creatorFirebaseUid,
      status: newStatus,
      toggleOnline: isAvailableToggleOn,
    });
  } catch (error) {
    logError('Failed to update creator availability after call', error, {
      creatorUserId,
    });
  }
}

export async function finalizeCreatorAvailabilityForCall(
  callId: string,
  creatorUserId: string
): Promise<void> {
  try {
    const creator = await Creator.findOne({ userId: creatorUserId });
    if (!creator) {
      logError(
        'Cannot finalize creator availability after call — creator not found',
        new Error('Creator missing'),
        { callId, creatorUserId }
      );
      return;
    }

    const creatorUser = await User.findById(creator.userId);
    const creatorFirebaseUid = creatorUser?.firebaseUid;
    if (!creatorFirebaseUid) {
      logInfo('Creator user has no firebaseUid; skipping final availability', {
        callId,
        creatorUserId,
      });
      return;
    }

    const redis = getRedis();
    const activeCallKey = activeCallByUserKey(creatorFirebaseUid);
    const activeCallId = await redis.get(activeCallKey);

    if (activeCallId && activeCallId !== callId) {
      logInfo('Skipping availability restore due to newer active call', {
        callId,
        creatorUserId,
        creatorFirebaseUid,
        activeCallId,
      });
      recordCallMetric('creator.restore.skipped_newer_call', 1, { callId });
      return;
    }

    if (activeCallId === callId) {
      await redis.del(activeCallKey);
    }

    const snapshot = await redis.get(precallSnapshotKey(callId, creatorFirebaseUid));
    const restoredStatus = (snapshot === 'online' || snapshot === 'busy'
      ? snapshot
      : 'online') as CreatorAvailability;

    if (shouldEnforceAvailabilityWrites()) {
      const restoreEvent =
        restoredStatus === 'online'
          ? featureFlags.creatorPresenceUserModelEnabled
            ? 'CONNECTED'
            : 'CALL_ENDED'
          : 'DISCONNECTED';
      await transitionCreatorPresence(
        getIO(),
        creatorFirebaseUid,
        restoreEvent,
        'creator-call-lock.finalizeCreatorAvailabilityForCall'
      );
    }
    await redis.del(precallSnapshotKey(callId, creatorFirebaseUid));
    recordCallMetric(snapshot != null ? 'creator.restore.snapshot_used' : 'creator.restore.snapshot_missing', 1, {
      callId,
      restoredStatus,
    });

    if (shouldEnforceAvailabilityWrites()) {
      try {
        const streamClient = getStreamClient();
        await streamClient.partialUpdateUser({
          id: creatorFirebaseUid,
          set: { busy: restoredStatus === 'busy' },
        });
      } catch (streamError) {
        logError('Failed to clear Stream Chat busy state after call (non-critical)', streamError, {
          callId,
          creatorFirebaseUid,
          restoredStatus,
        });
      }
    }

    logInfo('Creator availability finalized after call', {
      callId,
      creatorUserId,
      creatorFirebaseUid,
      restoredStatus,
      snapshotUsed: snapshot != null,
      mode: ORCHESTRATOR_MODE,
    });
  } catch (error) {
    logError('Failed to finalize creator availability after call', error, {
      callId,
      creatorUserId,
    });
    recordCallMetric('creator.restore.error', 1, { callId });
  }
}

