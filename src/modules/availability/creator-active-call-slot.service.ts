import { getRedis, activeCallByUserKey, callSessionKey, callSessionTerminalKey } from '../../config/redis';
import { Call } from '../video/call.model';
import { logInfo } from '../../utils/logger';
import { recordCallMetric } from '../../utils/monitoring';

let isCreatorActiveCallSlotLiveForTests:
  | ((slotCallId: string, creatorFirebaseUid: string) => Promise<boolean>)
  | null = null;

export function setIsCreatorActiveCallSlotLiveResolverForTests(
  resolver: ((slotCallId: string, creatorFirebaseUid: string) => Promise<boolean>) | null
): void {
  isCreatorActiveCallSlotLiveForTests = resolver;
}

export type ClearCreatorActiveCallSlotResult = {
  hadSlot: boolean;
  slotCallId: string | null;
  cleared: boolean;
  reason: string;
};

/**
 * True when the call tied to a creator's active-call slot is still in progress.
 */
export async function isCreatorActiveCallSlotLive(
  slotCallId: string,
  creatorFirebaseUid: string
): Promise<boolean> {
  if (isCreatorActiveCallSlotLiveForTests) {
    return isCreatorActiveCallSlotLiveForTests(slotCallId, creatorFirebaseUid);
  }

  const redis = getRedis();
  const terminalRaw = await redis.get(callSessionTerminalKey(slotCallId)).catch(() => null);
  if (terminalRaw) {
    return false;
  }

  const sessionRaw = await redis.get(callSessionKey(slotCallId)).catch(() => null);
  if (sessionRaw) {
    try {
      const session = JSON.parse(sessionRaw) as {
        userFirebaseUid?: string;
        creatorFirebaseUid?: string;
        lifecycleState?: string;
      };
      // The slot may belong to either party (payer or creator), but it must match one of them.
      const ownerMatchesSessionParty =
        (session.creatorFirebaseUid && session.creatorFirebaseUid === creatorFirebaseUid) ||
        (session.userFirebaseUid && session.userFirebaseUid === creatorFirebaseUid);
      if (!ownerMatchesSessionParty) {
        return false;
      }
      const lifecycle = String(session.lifecycleState || 'ACTIVE').toUpperCase();
      return lifecycle !== 'SETTLED' && lifecycle !== 'FAILED';
    } catch {
      return false;
    }
  }

  // Ringing may set the active-call slot before the billing session key exists.
  try {
    const call = await Call.findOne({ callId: slotCallId }).select('status isSettled').lean();
    if (!call) {
      return false;
    }
    if (call.status === 'ringing' || call.status === 'accepted') {
      return true;
    }
    return call.isSettled !== true;
  } catch {
    // Fail-safe: never drop an active-call slot when we cannot verify call state.
    return true;
  }
}

/**
 * Remove `active:call:user:{uid}` when it does not represent a live call.
 * Used at call end, presence transitions, admin reset-presence, and read-path self-heal.
 */
export async function clearCreatorActiveCallSlotIfStale(
  creatorFirebaseUid: string,
  options: {
    source: string;
    endingCallId?: string;
    /** Always delete the slot (admin reset-presence). */
    force?: boolean;
  }
): Promise<ClearCreatorActiveCallSlotResult> {
  const redis = getRedis();
  const key = activeCallByUserKey(creatorFirebaseUid);
  const slotCallId = await redis.get(key);
  if (!slotCallId) {
    return { hadSlot: false, slotCallId: null, cleared: false, reason: 'no_slot' };
  }

  if (options.force) {
    await redis.del(key).catch(() => 0);
    recordCallMetric('presence.stale_active_call_slot_cleared', 1, {
      source: options.source,
      reason: 'forced',
    });
    logInfo('Cleared creator active call slot (forced)', {
      creatorFirebaseUid,
      slotCallId,
      source: options.source,
    });
    return { hadSlot: true, slotCallId, cleared: true, reason: 'forced' };
  }

  if (options.endingCallId && slotCallId === options.endingCallId) {
    await redis.del(key).catch(() => 0);
    recordCallMetric('presence.stale_active_call_slot_cleared', 1, {
      source: options.source,
      reason: 'ending_call_match',
    });
    return { hadSlot: true, slotCallId, cleared: true, reason: 'ending_call_match' };
  }

  const live = await isCreatorActiveCallSlotLive(slotCallId, creatorFirebaseUid);
  if (!live) {
    await redis.del(key).catch(() => 0);
    recordCallMetric('presence.stale_active_call_slot_cleared', 1, {
      source: options.source,
      reason: 'slot_not_live',
    });
    logInfo('Cleared stale creator active call slot', {
      creatorFirebaseUid,
      slotCallId,
      endingCallId: options.endingCallId || null,
      source: options.source,
    });
    return { hadSlot: true, slotCallId, cleared: true, reason: 'slot_not_live' };
  }

  return { hadSlot: true, slotCallId, cleared: false, reason: 'slot_still_live' };
}
