import { Server } from 'socket.io';
import {
  getRedis,
  availabilityKey,
  creatorPresenceKey,
  activeCallByUserKey,
} from '../../config/redis';
import { getCreatorStaffScope, emitStaffDomainEvent } from '../staff/staff-dashboard-invalidation.service';
import { updateOnlinePresenceSets } from './presence-dashboard.service';
import {
  recordCreatorAvailabilityBecameBusy,
  recordCreatorAvailabilityBecameOnline,
} from './creator-daily-online.service';
import { recordCallMetric } from '../../utils/monitoring';
import { logInfo, logWarning, logError, logDebug } from '../../utils/logger';

export type CreatorPresenceState = 'online' | 'busy';
export type PresenceTransitionEventType =
  | 'CONNECTED'
  | 'HEARTBEAT'
  | 'CALL_STARTED'
  | 'CALL_ENDED'
  | 'DISCONNECTED'
  | 'RECOVERED'
  | 'FORCE_OFFLINE'
  | 'RECONCILED';

export type CreatorPresenceRecord = {
  state: CreatorPresenceState;
  updatedAt: number;
  source: string;
  version: number;
};

const PRESENCE_TTL_SECONDS = 120;

function parsePresenceRecord(raw: string | null): CreatorPresenceRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CreatorPresenceRecord>;
    const state: CreatorPresenceState = parsed.state === 'online' ? 'online' : 'busy';
    return {
      state,
      updatedAt: Number(parsed.updatedAt) || 0,
      source: String(parsed.source || 'unknown'),
      version: Math.max(0, Number(parsed.version) || 0),
    };
  } catch {
    return null;
  }
}

async function hasActiveCall(firebaseUid: string): Promise<boolean> {
  const redis = getRedis();
  const callId = await redis.get(activeCallByUserKey(firebaseUid));
  return Boolean(callId);
}

async function resolveTargetState(
  firebaseUid: string,
  eventType: PresenceTransitionEventType
): Promise<CreatorPresenceState> {
  switch (eventType) {
    case 'CALL_STARTED':
    case 'DISCONNECTED':
    case 'FORCE_OFFLINE':
      return 'busy';
    case 'CALL_ENDED':
    case 'CONNECTED':
    case 'HEARTBEAT':
    case 'RECOVERED':
    case 'RECONCILED':
    default:
      return (await hasActiveCall(firebaseUid)) ? 'busy' : 'online';
  }
}

export async function readCreatorPresenceState(firebaseUid: string): Promise<CreatorPresenceRecord> {
  const redis = getRedis();
  const raw = await redis.get(creatorPresenceKey(firebaseUid));
  const parsed = parsePresenceRecord(raw);
  if (parsed) {
    return parsed;
  }
  // Dual-read fallback to legacy key during migration.
  const legacy = await redis.get(availabilityKey(firebaseUid));
  logDebug('creator_presence_legacy_fallback', {
    firebaseUid,
    legacyState: legacy === 'online' ? 'online' : 'busy',
  });
  return {
    state: legacy === 'online' ? 'online' : 'busy',
    updatedAt: Date.now(),
    source: 'legacy_fallback',
    version: 0,
  };
}

export async function getBatchCreatorPresence(
  creatorIds: string[]
): Promise<Record<string, CreatorPresenceRecord>> {
  if (!creatorIds.length) return {};
  const redis = getRedis();
  const keys = creatorIds.map((id) => creatorPresenceKey(id));
  const raws = await redis.mget(...keys);
  const result: Record<string, CreatorPresenceRecord> = {};
  const legacyFallbackIds: string[] = [];

  creatorIds.forEach((id, idx) => {
    const parsed = parsePresenceRecord(raws[idx]);
    if (parsed) {
      result[id] = parsed;
    } else {
      legacyFallbackIds.push(id);
    }
  });

  if (legacyFallbackIds.length > 0) {
    logInfo('creator_presence_batch_legacy_fallback', {
      count: legacyFallbackIds.length,
      sampleIds: legacyFallbackIds.slice(0, 5),
    });
    const legacyKeys = legacyFallbackIds.map((id) => availabilityKey(id));
    const legacyVals = await redis.mget(...legacyKeys);
    legacyFallbackIds.forEach((id, idx) => {
      result[id] = {
        state: legacyVals[idx] === 'online' ? 'online' : 'busy',
        updatedAt: Date.now(),
        source: 'legacy_fallback_batch',
        version: 0,
      };
    });
  }

  return result;
}

export async function transitionCreatorPresence(
  io: Server,
  firebaseUid: string,
  eventType: PresenceTransitionEventType,
  source: string
): Promise<CreatorPresenceRecord> {
  const redis = getRedis();
  const current = await readCreatorPresenceState(firebaseUid);
  const nextState = await resolveTargetState(firebaseUid, eventType);
  const nextVersion = current.version + 1;
  const nextRecord: CreatorPresenceRecord = {
    state: nextState,
    updatedAt: Date.now(),
    source,
    version: nextVersion,
  };

  const activeCallId = await redis.get(activeCallByUserKey(firebaseUid));
  try {
    const pipelineResult = await redis
      .multi()
      .setex(creatorPresenceKey(firebaseUid), PRESENCE_TTL_SECONDS, JSON.stringify(nextRecord))
      // Dual-write legacy key for migration compatibility.
      .setex(availabilityKey(firebaseUid), PRESENCE_TTL_SECONDS, nextState)
      .exec();
    const pipelineFailed = pipelineResult?.some((entry) => entry?.[0] != null);
    if (pipelineFailed) {
      logError('creator_presence_redis_pipeline_failed', new Error('Redis MULTI/EXEC returned errors'), {
        firebaseUid,
        eventType,
        source,
        fromState: current.state,
        toState: nextState,
        activeCallId: activeCallId || null,
      });
    }
  } catch (redisErr) {
    logError('creator_presence_redis_write_failed', redisErr, {
      firebaseUid,
      eventType,
      source,
      fromState: current.state,
      toState: nextState,
      activeCallId: activeCallId || null,
      alert: true,
    });
    throw redisErr;
  }

  if (nextState === 'online') {
    await recordCreatorAvailabilityBecameOnline(firebaseUid);
  } else {
    await recordCreatorAvailabilityBecameBusy(firebaseUid);
  }

  const scope = await getCreatorStaffScope(firebaseUid);
  await updateOnlinePresenceSets(firebaseUid, nextState === 'online' ? 'online' : 'offline', scope);

  const statusChanged = current.state !== nextRecord.state;
  if (
    statusChanged ||
    eventType === 'RECOVERED' ||
    eventType === 'CONNECTED'
  ) {
    io.to('consumers').emit('creator:status', {
      creatorId: firebaseUid,
      status: nextRecord.state,
      version: nextRecord.version,
      updatedAt: nextRecord.updatedAt,
      source: nextRecord.source,
    });
    io.to('creators').emit('creator:status', {
      creatorId: firebaseUid,
      status: nextRecord.state,
      version: nextRecord.version,
      updatedAt: nextRecord.updatedAt,
      source: nextRecord.source,
    });
  }

  emitStaffDomainEvent({
    type: 'creator:status_changed',
    scope: { bdId: scope.bdId, agencyId: scope.agencyId },
    entityId: firebaseUid,
    meta: { status: nextRecord.state, version: nextRecord.version, source },
  });
  recordCallMetric('presence.transition', 1, {
    eventType,
    source,
    status: nextRecord.state,
    changed: statusChanged ? '1' : '0',
  });

  if (statusChanged || eventType === 'RECOVERED' || eventType === 'RECONCILED') {
    logInfo('creator_presence_transition', {
      firebaseUid,
      eventType,
      source,
      fromState: current.state,
      toState: nextRecord.state,
      version: nextRecord.version,
      statusChanged,
      activeCallId: activeCallId || null,
      previousSource: current.source,
    });
  } else {
    logDebug('creator_presence_heartbeat_no_status_change', {
      firebaseUid,
      eventType,
      source,
      state: nextRecord.state,
      version: nextRecord.version,
      activeCallId: activeCallId || null,
    });
  }

  if (
    statusChanged &&
    ((current.state === 'online' && nextRecord.state === 'busy') ||
      (current.state === 'busy' && nextRecord.state === 'online'))
  ) {
    const unexpectedBusyWhileNoCall =
      nextRecord.state === 'busy' && !activeCallId && eventType !== 'CALL_STARTED';
    if (unexpectedBusyWhileNoCall) {
      logWarning('creator_presence_busy_without_active_call', {
        firebaseUid,
        eventType,
        source,
        fromState: current.state,
        activeCallId: activeCallId || null,
      });
    }
  }

  return nextRecord;
}
