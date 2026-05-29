import { Server } from 'socket.io';
import {
  getRedis,
  getRedisEndpointMode,
  availabilityKey,
  activeCallByUserKey,
  creatorPresenceKey,
} from '../../config/redis';
import { featureFlags } from '../../config/feature-flags';
import { getCreatorStaffScope, emitStaffDomainEvent } from '../staff/staff-dashboard-invalidation.service';
import { updateOnlinePresenceSets } from './presence-dashboard.service';
import {
  recordCreatorAvailabilityBecameBusy,
  recordCreatorAvailabilityBecameOnline,
} from './creator-daily-online.service';
import { recordCallMetric } from '../../utils/monitoring';
import { logInfo, logWarning, logError, logDebug } from '../../utils/logger';

export type CreatorPresenceState = 'online' | 'busy';
type CreatorBaseAvailability = 'online' | 'offline';
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

type CreatorPresenceMeta = {
  base: CreatorBaseAvailability;
  updatedAt: number;
  source: string;
  version: number;
};

type CreatorPresenceSnapshot = {
  base: CreatorBaseAvailability;
  state: CreatorPresenceState;
  updatedAt: number;
  source: string;
  version: number;
};

const PRESENCE_TTL_SECONDS = 120;
const PRESENCE_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const META_KEY_PREFIX = 'creator:presence:meta:';
const ONLINE_SOURCE = 'user_model.base_online';
const OFFLINE_SOURCE = 'user_model.base_offline';

function creatorPresenceMetaKey(firebaseUid: string): string {
  return `${META_KEY_PREFIX}${firebaseUid}`;
}

function syntheticFallbackVersion(nowMs: number): number {
  return Math.max(0, Math.trunc(nowMs));
}

function parseBaseAvailability(raw: string | null): CreatorBaseAvailability {
  return raw === 'online' ? 'online' : 'offline';
}

function parsePresenceMeta(raw: string | null): CreatorPresenceMeta | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CreatorPresenceMeta> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.base !== 'online' && parsed.base !== 'offline') return null;
    const updatedAt = Number(parsed.updatedAt);
    if (
      !Number.isFinite(updatedAt) ||
      updatedAt <= 0 ||
      updatedAt > Date.now() + PRESENCE_MAX_CLOCK_SKEW_MS
    ) {
      return null;
    }
    const version = Number(parsed.version);
    if (!Number.isInteger(version) || version < 0) return null;
    const source = String(parsed.source || '').trim();
    if (!source) return null;
    return {
      base: parsed.base,
      updatedAt,
      source,
      version,
    };
  } catch {
    return null;
  }
}

function resolveTargetBaseAvailability(
  currentBase: CreatorBaseAvailability,
  eventType: PresenceTransitionEventType
): CreatorBaseAvailability {
  switch (eventType) {
    case 'FORCE_OFFLINE':
    case 'DISCONNECTED':
      return 'offline';
    case 'CONNECTED':
    case 'RECOVERED':
    case 'RECONCILED':
    case 'CALL_ENDED':
      return 'online';
    case 'CALL_STARTED':
    case 'HEARTBEAT':
    default:
      return currentBase;
  }
}

function derivePresenceState(
  base: CreatorBaseAvailability,
  hasActiveCallState: boolean
): CreatorPresenceState {
  if (hasActiveCallState) return 'busy';
  return base === 'online' ? 'online' : 'busy';
}

function deriveRecordSource(
  base: CreatorBaseAvailability,
  hasActiveCallState: boolean,
  source: string
): string {
  if (hasActiveCallState) return `${source}.active_call`;
  return base === 'online' ? source : OFFLINE_SOURCE;
}

function resolveLegacyTargetState(
  hasActiveCallState: boolean,
  eventType: PresenceTransitionEventType
): CreatorPresenceState {
  switch (eventType) {
    case 'FORCE_OFFLINE':
    case 'DISCONNECTED':
    case 'CALL_STARTED':
      return 'busy';
    default:
      return hasActiveCallState ? 'busy' : 'online';
  }
}

async function readCreatorPresenceSnapshot(firebaseUid: string): Promise<CreatorPresenceSnapshot> {
  const redis = getRedis();
  const [baseRaw, metaRaw, activeCallId] = await redis.mget(
    availabilityKey(firebaseUid),
    creatorPresenceMetaKey(firebaseUid),
    activeCallByUserKey(firebaseUid)
  );
  const base = parseBaseAvailability(baseRaw);
  const meta = parsePresenceMeta(metaRaw);
  const hasActiveCallState = Boolean(activeCallId);
  const updatedAt = meta?.updatedAt ?? Date.now();
  const source = deriveRecordSource(base, hasActiveCallState, meta?.source || ONLINE_SOURCE);
  const version = meta?.version ?? syntheticFallbackVersion(updatedAt);
  return {
    base,
    state: derivePresenceState(base, hasActiveCallState),
    updatedAt,
    source,
    version,
  };
}

export async function readCreatorPresenceState(firebaseUid: string): Promise<CreatorPresenceRecord> {
  const snapshot = await readCreatorPresenceSnapshot(firebaseUid);
  return {
    state: snapshot.state,
    updatedAt: snapshot.updatedAt,
    source: snapshot.source,
    version: snapshot.version,
  };
}

export async function getBatchCreatorPresence(
  creatorIds: string[]
): Promise<Record<string, CreatorPresenceRecord>> {
  if (!creatorIds.length) return {};
  const redis = getRedis();
  const baseKeys = creatorIds.map((id) => availabilityKey(id));
  const metaKeys = creatorIds.map((id) => creatorPresenceMetaKey(id));
  const activeCallKeys = creatorIds.map((id) => activeCallByUserKey(id));
  const [baseVals, metaVals, activeCallVals] = await Promise.all([
    redis.mget(...baseKeys),
    redis.mget(...metaKeys),
    redis.mget(...activeCallKeys),
  ]);
  const result: Record<string, CreatorPresenceRecord> = {};
  let canonicalMissingCount = 0;
  let fallbackCount = 0;

  creatorIds.forEach((id, idx) => {
    const base = parseBaseAvailability(baseVals[idx]);
    const meta = parsePresenceMeta(metaVals[idx]);
    const hasActiveCallState = Boolean(activeCallVals[idx]);
    const updatedAt = meta?.updatedAt ?? Date.now();
    const derivedSource = deriveRecordSource(base, hasActiveCallState, meta?.source || ONLINE_SOURCE);
    if (!meta) {
      canonicalMissingCount += 1;
    }
    if (!meta || derivedSource.includes('fallback') || derivedSource === OFFLINE_SOURCE) {
      fallbackCount += 1;
    }
    result[id] = {
      state: derivePresenceState(base, hasActiveCallState),
      updatedAt,
      source: derivedSource,
      version: meta?.version ?? syntheticFallbackVersion(updatedAt),
    };
  });
  const batchSize = creatorIds.length;
  if (batchSize > 0) {
    const canonicalMissingRate = canonicalMissingCount / batchSize;
    const fallbackRate = fallbackCount / batchSize;
    recordCallMetric('presence.creator_batch_canonical_missing', canonicalMissingCount, {
      batchSize: String(batchSize),
    });
    recordCallMetric('presence.creator_batch_canonical_missing_rate', canonicalMissingRate, {
      batchSize: String(batchSize),
    });
    recordCallMetric('creator_presence_canonical_missing_rate', canonicalMissingRate, {
      batchSize: String(batchSize),
    });
    recordCallMetric('presence.creator_batch_fallback', fallbackCount, {
      batchSize: String(batchSize),
    });
    recordCallMetric('presence.creator_batch_fallback_rate', fallbackRate, {
      batchSize: String(batchSize),
    });
    recordCallMetric('creator_presence_fallback_rate', fallbackRate, {
      batchSize: String(batchSize),
    });
    if (canonicalMissingRate > 0.05) {
      logWarning('creator_presence_batch_canonical_missing_high', {
        batchSize,
        count: canonicalMissingCount,
        missingRate: canonicalMissingRate,
        threshold: 0.05,
      });
    }
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
  const current = await readCreatorPresenceSnapshot(firebaseUid);
  const nextBase = resolveTargetBaseAvailability(current.base, eventType);
  const activeCallId = await redis.get(activeCallByUserKey(firebaseUid));
  const hasActiveCallState = Boolean(activeCallId);
  const nextState = derivePresenceState(nextBase, hasActiveCallState);
  const now = Date.now();
  const nextVersion = Math.max(current.version + 1, syntheticFallbackVersion(now));
  const nextRecord: CreatorPresenceRecord = {
    state: nextState,
    updatedAt: now,
    source: deriveRecordSource(nextBase, hasActiveCallState, source || ONLINE_SOURCE),
    version: nextVersion,
  };

  try {
    const pipeline = redis
      .multi()
      .setex(availabilityKey(firebaseUid), PRESENCE_TTL_SECONDS, nextBase)
      .setex(
        creatorPresenceKey(firebaseUid),
        PRESENCE_TTL_SECONDS,
        JSON.stringify({
          state: nextRecord.state,
          updatedAt: nextRecord.updatedAt,
          source: nextRecord.source,
          version: nextRecord.version,
        })
      )
      .setex(
        creatorPresenceMetaKey(firebaseUid),
        PRESENCE_TTL_SECONDS,
        JSON.stringify({
          base: nextBase,
          updatedAt: nextRecord.updatedAt,
          source: source || (nextBase === 'online' ? ONLINE_SOURCE : OFFLINE_SOURCE),
          version: nextRecord.version,
        } satisfies CreatorPresenceMeta)
      );
    const pipelineResult = await pipeline.exec();
    const pipelineFailed = pipelineResult?.some((entry) => entry?.[0] != null);
    if (pipelineFailed) {
      logError('creator_presence_redis_pipeline_failed', new Error('Redis MULTI/EXEC returned errors'), {
        firebaseUid,
        eventType,
        source,
        fromState: current.state,
        toState: nextState,
        toBase: nextBase,
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
      toBase: nextBase,
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

  const statusChanged = current.state !== nextRecord.state || current.base !== nextBase;
  if (
    statusChanged ||
    eventType === 'RECOVERED' ||
    eventType === 'CONNECTED' ||
    eventType === 'CALL_STARTED' ||
    eventType === 'CALL_ENDED'
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
    meta: { status: nextRecord.state, base: nextBase, version: nextRecord.version, source },
  });
  recordCallMetric('presence.transition', 1, {
    eventType,
    source,
    status: nextRecord.state,
    changed: statusChanged ? '1' : '0',
  });

  if (featureFlags.creatorPresenceUserModelShadowCompareEnabled) {
    const legacyTarget = resolveLegacyTargetState(hasActiveCallState, eventType);
    if (legacyTarget !== nextRecord.state) {
      recordCallMetric('presence.user_model_shadow_mismatch', 1, {
        eventType,
        legacyTarget,
        userModelTarget: nextRecord.state,
      });
      logWarning('creator_presence_user_model_shadow_mismatch', {
        firebaseUid,
        eventType,
        source,
        legacyTarget,
        userModelTarget: nextRecord.state,
        base: nextBase,
        hasActiveCall: hasActiveCallState,
      });
    }
  }

  if (statusChanged || eventType === 'RECOVERED' || eventType === 'RECONCILED') {
    logInfo('creator_presence_transition', {
      firebaseUid,
      eventType,
      source,
      redisEndpointMode: getRedisEndpointMode(),
      fromState: current.state,
      toState: nextRecord.state,
      fromBase: current.base,
      toBase: nextBase,
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
      base: nextBase,
      version: nextRecord.version,
      activeCallId: activeCallId || null,
    });
  }

  if (eventType === 'CALL_ENDED' && source.includes('billing') && nextRecord.state === 'online') {
    recordCallMetric('presence.contract.call_ended_to_online', 1, {
      source,
      previousState: current.state,
      activeCall: activeCallId ? '1' : '0',
    });
  }

  if (nextRecord.state === 'busy' && !activeCallId && nextBase === 'online') {
    logWarning('creator_presence_busy_without_active_call', {
      firebaseUid,
      eventType,
      source,
      base: nextBase,
      activeCallId: activeCallId || null,
    });
  }

  return nextRecord;
}
