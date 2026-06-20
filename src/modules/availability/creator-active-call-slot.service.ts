import {
  getRedis,
  activeCallByUserKey,
  callSessionKey,
  callSessionTerminalKey,
  pendingCallEndKey,
  callEndingKey,
} from '../../config/redis';
import { Call } from '../video/call.model';
import { logInfo } from '../../utils/logger';
import { recordCallMetric } from '../../utils/monitoring';

const PRECALL_SNAPSHOT_PREFIX = 'call:precall:availability:';
/** Same TTL as markCreatorBusyForCall slot writes (2 hours). */
export const ACTIVE_CALL_SLOT_TTL_SECONDS = 60 * 60 * 2;
/** Grace window while Mongo / billing session may lag behind Redis slot write. */
export const RINGING_SLOT_GRACE_SECONDS = Math.min(
  300,
  Math.max(30, parseInt(process.env.RINGING_SLOT_GRACE_SECONDS || '120', 10) || 120)
);
/** Reconciliation sweep clears slots older than grace once durable call validation fails. */
const PRESENCE_SLOT_SWEEP_MIN_AGE_SECONDS = Math.min(
  ACTIVE_CALL_SLOT_TTL_SECONDS - 60,
  Math.max(
    RINGING_SLOT_GRACE_SECONDS + 30,
    parseInt(process.env.PRESENCE_SLOT_SWEEP_MIN_AGE_SECONDS || String(RINGING_SLOT_GRACE_SECONDS + 60), 10) ||
      RINGING_SLOT_GRACE_SECONDS + 60
  )
);

const precallSnapshotKey = (callId: string, creatorFirebaseUid: string): string =>
  `${PRECALL_SNAPSHOT_PREFIX}${callId}:${creatorFirebaseUid}`;

let isCreatorActiveCallSlotLiveForTests:
  | ((slotCallId: string, creatorFirebaseUid: string) => Promise<boolean>)
  | null = null;

let resolveCallRecordForTests:
  | ((callId: string) => Promise<{ status: string; isSettled?: boolean } | null>)
  | null = null;

export function setIsCreatorActiveCallSlotLiveResolverForTests(
  resolver: ((slotCallId: string, creatorFirebaseUid: string) => Promise<boolean>) | null
): void {
  isCreatorActiveCallSlotLiveForTests = resolver;
}

export function setResolveCallRecordForTests(
  resolver: ((callId: string) => Promise<{ status: string; isSettled?: boolean } | null>) | null
): void {
  resolveCallRecordForTests = resolver;
}

function computeSlotAgeSecondsFromTtl(ttl: number): number | null {
  if (!Number.isFinite(ttl) || ttl <= 0) return null;
  return Math.max(0, ACTIVE_CALL_SLOT_TTL_SECONDS - ttl);
}

function recordSlotWithoutMongoCallMetric(
  reason: 'precall_snapshot' | 'ttl_grace',
  slotAgeSeconds: number | null
): void {
  recordCallMetric('presence_slot_without_mongo_call_total', 1, { reason });
  if (slotAgeSeconds != null) {
    recordCallMetric('presence_slot_without_mongo_call_age_seconds', slotAgeSeconds, { reason });
  }
}

export type ClearCreatorActiveCallSlotResult = {
  hadSlot: boolean;
  slotCallId: string | null;
  cleared: boolean;
  reason: string;
};

export type ActiveCallSlotLiveContext = 'default' | 'reconciliation_sweep';

/**
 * True when the call tied to a creator's active-call slot is still in progress.
 */
export async function isCreatorActiveCallSlotLive(
  slotCallId: string,
  creatorFirebaseUid: string,
  context: ActiveCallSlotLiveContext = 'default'
): Promise<boolean> {
  if (isCreatorActiveCallSlotLiveForTests) {
    return isCreatorActiveCallSlotLiveForTests(slotCallId, creatorFirebaseUid);
  }

  const redis = getRedis();
  const [endingFlag, pendingEnd] = await Promise.all([
    redis.get(callEndingKey(slotCallId)).catch(() => null),
    redis.get(pendingCallEndKey(slotCallId)).catch(() => null),
  ]);
  if (endingFlag || pendingEnd) {
    return false;
  }

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

  // Ringing may set the active-call slot before the billing session or Mongo Call row exists.
  try {
    const call = resolveCallRecordForTests
      ? await resolveCallRecordForTests(slotCallId)
      : await Call.findOne({ callId: slotCallId }).select('status isSettled').lean();
    if (!call) {
      if (context === 'reconciliation_sweep') {
        return false;
      }
      const slotKey = activeCallByUserKey(creatorFirebaseUid);
      const ttl = await redis.ttl(slotKey).catch(() => -2);
      const slotAgeSeconds = computeSlotAgeSecondsFromTtl(ttl);
      const precallExists = await redis
        .get(precallSnapshotKey(slotCallId, creatorFirebaseUid))
        .catch(() => null);
      if (precallExists) {
        recordSlotWithoutMongoCallMetric('precall_snapshot', slotAgeSeconds);
        return true;
      }
      if (ttl > 0 && ttl >= ACTIVE_CALL_SLOT_TTL_SECONDS - RINGING_SLOT_GRACE_SECONDS) {
        recordSlotWithoutMongoCallMetric('ttl_grace', slotAgeSeconds);
        return true;
      }
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
 * Used at call end, presence transitions, admin reset-presence, and reconciliation.
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

export type ReconciliationSweepResult = ClearCreatorActiveCallSlotResult & {
  slotAgeSeconds: number | null;
};

/**
 * Reconciliation-only sweep: age-gated durable validation that bypasses ringing grace
 * once the slot is older than {@link PRESENCE_SLOT_SWEEP_MIN_AGE_SECONDS}.
 *
 * Prevents crash orphans from persisting until precall/slot TTL expiry while still
 * respecting the grace window for in-flight webhook + Mongo ordering.
 */
export async function clearActiveCallSlotForReconciliationSweep(
  creatorFirebaseUid: string,
  source: string
): Promise<ReconciliationSweepResult> {
  const redis = getRedis();
  const key = activeCallByUserKey(creatorFirebaseUid);
  const slotCallId = await redis.get(key);
  if (!slotCallId) {
    return { hadSlot: false, slotCallId: null, cleared: false, reason: 'no_slot', slotAgeSeconds: null };
  }

  const ttl = await redis.ttl(key).catch(() => -2);
  const slotAgeSeconds = computeSlotAgeSecondsFromTtl(ttl);
  if (slotAgeSeconds == null || slotAgeSeconds < PRESENCE_SLOT_SWEEP_MIN_AGE_SECONDS) {
    recordCallMetric('presence.reconciliation_sweep_skipped_grace', 1, {
      source,
      slotAgeSeconds: String(slotAgeSeconds ?? -1),
      minAgeSeconds: String(PRESENCE_SLOT_SWEEP_MIN_AGE_SECONDS),
    });
    return {
      hadSlot: true,
      slotCallId,
      cleared: false,
      reason: 'within_sweep_grace_window',
      slotAgeSeconds,
    };
  }

  const live = await isCreatorActiveCallSlotLive(slotCallId, creatorFirebaseUid, 'reconciliation_sweep');
  if (live) {
    recordCallMetric('presence.reconciliation_sweep_skipped_live', 1, { source });
    return {
      hadSlot: true,
      slotCallId,
      cleared: false,
      reason: 'slot_still_live',
      slotAgeSeconds,
    };
  }

  await redis.del(key).catch(() => 0);
  recordCallMetric('presence.stale_active_call_slot_cleared', 1, {
    source,
    reason: 'reconciliation_sweep_orphan',
  });
  recordCallMetric('presence.reconciliation_sweep_cleared', 1, {
    source,
    slotAgeSeconds: String(slotAgeSeconds),
  });
  logInfo('Reconciliation sweep cleared orphan active call slot', {
    creatorFirebaseUid,
    slotCallId,
    slotAgeSeconds,
    minAgeSeconds: PRESENCE_SLOT_SWEEP_MIN_AGE_SECONDS,
    source,
  });
  return {
    hadSlot: true,
    slotCallId,
    cleared: true,
    reason: 'reconciliation_sweep_orphan',
    slotAgeSeconds,
  };
}
