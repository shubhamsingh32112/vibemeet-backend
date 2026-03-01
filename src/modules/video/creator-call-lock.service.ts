import { Creator } from '../creator/creator.model';
import { User } from '../user/user.model';
import { getStreamClient } from '../../config/stream';
import { setAvailability } from '../availability/availability.service';
import { emitCreatorStatus } from '../availability/availability.socket';
import { logError, logInfo } from '../../utils/logger';

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
    await setAvailability(creatorFirebaseUid, 'busy');
    emitCreatorStatus(creatorFirebaseUid, 'busy');

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

    await setAvailability(creatorFirebaseUid, newStatus);
    emitCreatorStatus(creatorFirebaseUid, newStatus);

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

