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

export type CreatorPresenceState = 'online' | 'on_call' | 'offline';
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

const PRESENCE_TTL_SECONDS = Math.min(
  600,
  Math.max(90, parseInt(process.env.CREATOR_PRESENCE_TTL_SECONDS || '180', 10) || 180)
);
const PRESENCE_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const META_KEY_PREFIX = 'creator:presence:meta:';
const ONLINE_SOURCE = 'user_model.base_online';
const OFFLINE_SOURCE = 'user_model.base_offline';
const UNKNOWN_SOURCE = 'presence.unknown_source';
const PRESENCE_WRITE_MAX_RETRIES = Math.min(
  2,
  Math.max(0, parseInt(process.env.CREATOR_PRESENCE_WRITE_MAX_RETRIES || '1', 10) || 1)
);
const META_SELF_HEAL_MAX_PER_BATCH = Math.min(
  20,
  Math.max(0, parseInt(process.env.CREATOR_PRESENCE_META_SELF_HEAL_MAX_PER_BATCH || '3', 10) || 3)
);
const MIN_EXPECTED_CANONICAL_FOR_WARN = Math.min(
  100,
  Math.max(1, parseInt(process.env.CREATOR_PRESENCE_MIN_EXPECTED_FOR_WARN || '5', 10) || 5)
);
const UID_CONTRACT_SAMPLE_LIMIT = Math.min(
  5,
  Math.max(1, parseInt(process.env.CREATOR_PRESENCE_UID_SAMPLE_LIMIT || '3', 10) || 3)
);

export function creatorPresenceMetaKey(firebaseUid: string): string {
  return `${META_KEY_PREFIX}${firebaseUid}`;
}

function sanitizePresenceSource(source: string | null | undefined): string {
  const normalized = String(source || '').trim();
  return normalized.length > 0 ? normalized : UNKNOWN_SOURCE;
}

function fingerprintPresenceMetaRaw(raw: string): string {
  if (!raw) return 'empty';
  const trimmed = raw.trim();
  return `${trimmed.length}:${trimmed.slice(0, 32)}`;
}

function isLikelyFirebaseUid(uid: string): boolean {
  return /^[A-Za-z0-9:_-]{8,128}$/.test(uid);
}

export function normalizeFirebaseUids(rawIds: string[]): {
  firebaseUids: string[];
  invalidUids: string[];
} {
  const validSet = new Set<string>();
  const invalid: string[] = [];
  for (const raw of rawIds) {
    const uid = String(raw || '').trim();
    if (!uid || !isLikelyFirebaseUid(uid)) {
      if (uid) invalid.push(uid);
      continue;
    }
    validSet.add(uid);
  }
  return {
    firebaseUids: Array.from(validSet),
    invalidUids: invalid,
  };
}

function syntheticFallbackVersion(nowMs: number): number {
  return Math.max(0, Math.trunc(nowMs));
}

function parseBaseAvailability(raw: string | null): CreatorBaseAvailability {
  return raw === 'online' ? 'online' : 'offline';
}

function parsePresenceMeta(raw: string | null): { meta: CreatorPresenceMeta | null; reason: string } {
  if (!raw) return { meta: null, reason: 'missing' };
  try {
    const parsed = JSON.parse(raw) as Partial<CreatorPresenceMeta> | null;
    if (!parsed || typeof parsed !== 'object') return { meta: null, reason: 'invalid_shape' };
    if (parsed.base !== 'online' && parsed.base !== 'offline') return { meta: null, reason: 'invalid_base' };
    const updatedAt = Number(parsed.updatedAt);
    if (
      !Number.isFinite(updatedAt) ||
      updatedAt <= 0 ||
      updatedAt > Date.now() + PRESENCE_MAX_CLOCK_SKEW_MS
    ) {
      return { meta: null, reason: 'invalid_updatedAt' };
    }
    const version = Number(parsed.version);
    if (!Number.isInteger(version) || version < 0) return { meta: null, reason: 'invalid_version' };
    const source = String(parsed.source || '').trim();
    if (!source) return { meta: null, reason: 'invalid_source' };
    return {
      meta: {
        base: parsed.base,
        updatedAt,
        source,
        version,
      },
      reason: 'ok',
    };
  } catch {
    return { meta: null, reason: 'invalid_json' };
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    case 'CALL_ENDED':
      return 'online';
    case 'RECONCILED':
      return currentBase;
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
  if (hasActiveCallState) return 'on_call';
  return base === 'online' ? 'online' : 'offline';
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
      return 'offline';
    case 'CALL_STARTED':
      return 'on_call';
    default:
      return hasActiveCallState ? 'on_call' : 'online';
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
  const parsedMeta = parsePresenceMeta(metaRaw);
  const meta = parsedMeta.meta;
  const hasActiveCallState = Boolean(activeCallId);
  const updatedAt = meta?.updatedAt ?? Date.now();
  const source = deriveRecordSource(base, hasActiveCallState, sanitizePresenceSource(meta?.source || ONLINE_SOURCE));
  const version = meta?.version ?? syntheticFallbackVersion(updatedAt);
  const endpointMode = getRedisEndpointMode();
  recordCallMetric('presence.creator_meta_age_ms', Math.max(0, Date.now() - updatedAt), {
    endpointMode,
    source: meta?.source ? 'canonical' : 'fallback',
  });
  if (!meta) {
    recordCallMetric('presence.creator_meta_missing', 1, {
      endpointMode,
      reason: parsedMeta.reason,
    });
    if (parsedMeta.reason !== 'missing') {
      recordCallMetric('presence.creator_meta_parse_failure', 1, {
        endpointMode,
        reason: parsedMeta.reason,
      });
      logWarning('creator_presence_meta_parse_failed', {
        firebaseUid,
        reason: parsedMeta.reason,
        rawFingerprint: metaRaw ? fingerprintPresenceMetaRaw(metaRaw) : 'none',
        endpointMode,
      });
    }
  }
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

async function selfHealMissingMeta(firebaseUid: string, base: CreatorBaseAvailability): Promise<void> {
  const redis = getRedis();
  const now = Date.now();
  const source = sanitizePresenceSource('availability.read_self_heal');
  await redis.setex(
    creatorPresenceMetaKey(firebaseUid),
    PRESENCE_TTL_SECONDS,
    JSON.stringify({
      base,
      updatedAt: now,
      source,
      version: syntheticFallbackVersion(now),
    } satisfies CreatorPresenceMeta)
  );
  recordCallMetric('presence.creator_meta_self_heal_write', 1, {
    endpointMode: getRedisEndpointMode(),
    base,
  });
}

export async function getBatchCreatorPresence(
  firebaseUids: string[]
): Promise<Record<string, CreatorPresenceRecord>> {
  if (!firebaseUids.length) return {};
  const redis = getRedis();
  const endpointMode = getRedisEndpointMode();
  const normalized = normalizeFirebaseUids(firebaseUids);
  const validFirebaseUids = normalized.firebaseUids;
  const invalidUids = normalized.invalidUids;
  if (invalidUids.length > 0) {
    recordCallMetric('presence.creator_uid_contract_violation', invalidUids.length, {
      endpointMode,
      context: 'getBatchCreatorPresence',
    });
    recordCallMetric(
      'presence.creator_uid_contract_violation_rate',
      invalidUids.length / Math.max(firebaseUids.length, 1),
      {
        endpointMode,
        context: 'getBatchCreatorPresence',
      }
    );
    logWarning('creator_presence_uid_contract_violation', {
      invalidCount: invalidUids.length,
      validCount: validFirebaseUids.length,
      sample: invalidUids.slice(0, UID_CONTRACT_SAMPLE_LIMIT),
      endpointMode,
      enforce: featureFlags.creatorPresenceUidContractEnforced,
    });
    if (featureFlags.creatorPresenceUidContractEnforced && validFirebaseUids.length === 0) {
      recordCallMetric('presence.creator_uid_contract_enforced_block', 1, {
        endpointMode,
        context: 'getBatchCreatorPresence',
      });
      return {};
    }
  }
  if (!validFirebaseUids.length) return {};

  const baseKeys = validFirebaseUids.map((id) => availabilityKey(id));
  const metaKeys = validFirebaseUids.map((id) => creatorPresenceMetaKey(id));
  const activeCallKeys = validFirebaseUids.map((id) => activeCallByUserKey(id));
  const [baseVals, metaVals, activeCallVals] = await Promise.all([
    redis.mget(...baseKeys).catch((err) => {
      logError('creator_presence_batch_read_failed', err, {
        endpointMode,
        operation: 'read_base',
        size: validFirebaseUids.length,
      });
      throw err;
    }),
    redis.mget(...metaKeys).catch((err) => {
      logError('creator_presence_batch_read_failed', err, {
        endpointMode,
        operation: 'read_meta',
        size: validFirebaseUids.length,
      });
      throw err;
    }),
    redis.mget(...activeCallKeys).catch((err) => {
      logError('creator_presence_batch_read_failed', err, {
        endpointMode,
        operation: 'read_active_call',
        size: validFirebaseUids.length,
      });
      throw err;
    }),
  ]);
  const result: Record<string, CreatorPresenceRecord> = {};
  let canonicalMissingExpectedCount = 0;
  let expectedCanonicalCount = 0;
  let fallbackCount = 0;
  let metaMissingAnyCount = 0;
  let metaMissingExpectedCount = 0;
  let metaParseFailureCount = 0;
  const selfHealCandidates: Array<{ firebaseUid: string; base: CreatorBaseAvailability }> = [];

  validFirebaseUids.forEach((id, idx) => {
    const baseRaw = baseVals[idx];
    const base = parseBaseAvailability(baseVals[idx]);
    const parsedMeta = parsePresenceMeta(metaVals[idx]);
    const meta = parsedMeta.meta;
    const hasActiveCallState = Boolean(activeCallVals[idx]);
    const expectedCanonical = baseRaw != null || hasActiveCallState;
    const updatedAt = meta?.updatedAt ?? Date.now();
    const derivedSource = deriveRecordSource(
      base,
      hasActiveCallState,
      sanitizePresenceSource(meta?.source || ONLINE_SOURCE)
    );
    if (expectedCanonical) {
      expectedCanonicalCount += 1;
    }
    if (!meta) {
      metaMissingAnyCount += 1;
      if (expectedCanonical) {
        canonicalMissingExpectedCount += 1;
        metaMissingExpectedCount += 1;
      }
      if (parsedMeta.reason !== 'missing') {
        metaParseFailureCount += 1;
        recordCallMetric('presence.creator_meta_parse_failure', 1, {
          endpointMode,
          reason: parsedMeta.reason,
        });
      }
      recordCallMetric('presence.creator_meta_missing', 1, {
        endpointMode,
        reason: parsedMeta.reason,
      });
      if (featureFlags.creatorPresenceMetaSelfHealEnabled && expectedCanonical) {
        selfHealCandidates.push({ firebaseUid: id, base });
      }
    }
    if (!meta || derivedSource.includes('fallback') || derivedSource === OFFLINE_SOURCE) {
      fallbackCount += 1;
    }
    recordCallMetric('presence.creator_meta_age_ms', Math.max(0, Date.now() - updatedAt), {
      endpointMode,
      source: meta?.source ? 'canonical' : 'fallback',
    });
    result[id] = {
      state: derivePresenceState(base, hasActiveCallState),
      updatedAt,
      source: derivedSource,
      version: meta?.version ?? syntheticFallbackVersion(updatedAt),
    };
  });
  const batchSize = validFirebaseUids.length;
  if (batchSize > 0) {
    const canonicalMissingRate = canonicalMissingExpectedCount / Math.max(expectedCanonicalCount, 1);
    const fallbackRate = fallbackCount / batchSize;
    const metaMissingAnyRate = metaMissingAnyCount / batchSize;
    const metaMissingExpectedRate = metaMissingExpectedCount / Math.max(expectedCanonicalCount, 1);
    const metaParseFailureRate = metaParseFailureCount / batchSize;
    const expectedCoverageRate = expectedCanonicalCount / Math.max(batchSize, 1);
    recordCallMetric('presence.creator_batch_canonical_missing', canonicalMissingExpectedCount, {
      batchSize: String(batchSize),
      expectedCanonicalCount: String(expectedCanonicalCount),
      endpointMode,
    });
    recordCallMetric('presence.creator_batch_canonical_missing_rate', canonicalMissingRate, {
      batchSize: String(batchSize),
      endpointMode,
    });
    recordCallMetric('creator_presence_canonical_missing_rate', canonicalMissingRate, {
      batchSize: String(batchSize),
      expectedCanonicalCount: String(expectedCanonicalCount),
      endpointMode,
    });
    recordCallMetric('presence.creator_batch_fallback', fallbackCount, {
      batchSize: String(batchSize),
      endpointMode,
    });
    recordCallMetric('presence.creator_batch_fallback_rate', fallbackRate, {
      batchSize: String(batchSize),
      endpointMode,
    });
    recordCallMetric('creator_presence_fallback_rate', fallbackRate, {
      batchSize: String(batchSize),
      endpointMode,
    });
    recordCallMetric('presence.creator_meta_missing_rate', metaMissingExpectedRate, {
      batchSize: String(batchSize),
      expectedCanonicalCount: String(expectedCanonicalCount),
      endpointMode,
    });
    recordCallMetric('presence.creator_meta_missing_any_rate', metaMissingAnyRate, {
      batchSize: String(batchSize),
      endpointMode,
    });
    recordCallMetric('presence.creator_meta_missing_expected_rate', metaMissingExpectedRate, {
      batchSize: String(batchSize),
      expectedCanonicalCount: String(expectedCanonicalCount),
      endpointMode,
    });
    recordCallMetric('presence.creator_expected_canonical_coverage_rate', expectedCoverageRate, {
      batchSize: String(batchSize),
      endpointMode,
    });
    recordCallMetric('presence.creator_meta_parse_failure_rate', metaParseFailureRate, {
      batchSize: String(batchSize),
      endpointMode,
    });
    if (expectedCanonicalCount >= MIN_EXPECTED_CANONICAL_FOR_WARN && canonicalMissingRate > 0.05) {
      logWarning('creator_presence_batch_canonical_missing_high', {
        batchSize,
        expectedCanonicalCount,
        count: canonicalMissingExpectedCount,
        missingRate: canonicalMissingRate,
        threshold: 0.05,
        endpointMode,
      });
    }
    if (metaParseFailureCount > 0) {
      logWarning('creator_presence_batch_meta_parse_failure_detected', {
        batchSize,
        count: metaParseFailureCount,
        parseFailureRate: metaParseFailureRate,
        endpointMode,
      });
    }
  }

  if (selfHealCandidates.length > 0) {
    const healTargets = selfHealCandidates.slice(0, META_SELF_HEAL_MAX_PER_BATCH);
    recordCallMetric('presence.creator_meta_self_heal_attempt', healTargets.length, { endpointMode });
    await Promise.all(
      healTargets.map(async (candidate) => {
        try {
          await selfHealMissingMeta(candidate.firebaseUid, candidate.base);
        } catch (err) {
          recordCallMetric('presence.creator_meta_self_heal_failure', 1, { endpointMode });
          logError('creator_presence_meta_self_heal_failed', err, {
            firebaseUid: candidate.firebaseUid,
            endpointMode,
          });
        }
      })
    );
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
  const endpointMode = getRedisEndpointMode();
  const safeSource = sanitizePresenceSource(source);
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
    source: deriveRecordSource(nextBase, hasActiveCallState, safeSource || ONLINE_SOURCE),
    version: nextVersion,
  };

  if (!nextRecord.source || !nextRecord.updatedAt || !Number.isInteger(nextRecord.version)) {
    logWarning('creator_presence_writer_invariant_failed', {
      firebaseUid,
      eventType,
      source: safeSource,
      state: nextRecord.state,
      updatedAt: nextRecord.updatedAt,
      version: nextRecord.version,
      endpointMode,
    });
  }

  const retries = featureFlags.creatorPresenceWriterRetryEnabled ? PRESENCE_WRITE_MAX_RETRIES : 0;
  const maxAttempts = 1 + retries;
  let writeSucceeded = false;
  let lastWriteErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
            source: safeSource || (nextBase === 'online' ? ONLINE_SOURCE : OFFLINE_SOURCE),
            version: nextRecord.version,
          } satisfies CreatorPresenceMeta)
        );
      const pipelineResult = await pipeline.exec();
      const pipelineFailed = !pipelineResult || pipelineResult.some((entry) => entry?.[0] != null);
      if (pipelineFailed) {
        recordCallMetric('presence.creator_transition_write_partial_failure', 1, {
          endpointMode,
          attempt: String(attempt),
        });
        throw new Error('Redis MULTI/EXEC returned errors');
      }
      if (attempt > 1) {
        recordCallMetric('presence.creator_transition_retry_count', attempt - 1, {
          endpointMode,
          outcome: 'recovered',
        });
      }
      writeSucceeded = true;
      break;
    } catch (redisErr) {
      lastWriteErr = redisErr;
      const hasRetryRemaining = attempt < maxAttempts;
      if (hasRetryRemaining) {
        recordCallMetric('presence.creator_transition_retry_count', 1, {
          endpointMode,
          outcome: 'retry',
        });
        await sleepMs(25 + Math.floor(Math.random() * 50));
        continue;
      }
      recordCallMetric('presence.creator_transition_retry_count', attempt - 1, {
        endpointMode,
        outcome: 'exhausted',
      });
      logError('creator_presence_redis_write_failed', redisErr, {
        firebaseUid,
        eventType,
        source: safeSource,
        fromState: current.state,
        toState: nextState,
        toBase: nextBase,
        activeCallId: activeCallId || null,
        endpointMode,
        attempts: maxAttempts,
        alert: true,
      });
      break;
    }
  }
  if (!writeSucceeded) {
    throw lastWriteErr instanceof Error ? lastWriteErr : new Error('creator presence write failed');
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
    meta: { status: nextRecord.state, base: nextBase, version: nextRecord.version, source: safeSource },
  });
  recordCallMetric('presence.transition', 1, {
    eventType,
    source: safeSource,
    status: nextRecord.state,
    changed: statusChanged ? '1' : '0',
  });
  logDebug('creator_presence_transition_eval', {
    firebaseUid,
    eventType,
    source: safeSource,
    activeCallExists: hasActiveCallState,
    derivedState: nextRecord.state,
    version: nextRecord.version,
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
        source: safeSource,
        legacyTarget,
        userModelTarget: nextRecord.state,
        base: nextBase,
        hasActiveCall: hasActiveCallState,
      });
    }
  }

  if (statusChanged || eventType === 'RECOVERED' || eventType === 'RECONCILED') {
    logInfo('creator_status_change', {
      firebaseUid,
      from: current.state,
      to: nextRecord.state,
      fromBase: current.base,
      toBase: nextBase,
      eventType,
      source: safeSource,
      redisEndpointMode: getRedisEndpointMode(),
      version: nextRecord.version,
      statusChanged,
      activeCallId: activeCallId || null,
      previousSource: current.source,
    });
    logInfo('creator_presence_transition', {
      firebaseUid,
      eventType,
      source: safeSource,
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
      source: safeSource,
      state: nextRecord.state,
      base: nextBase,
      version: nextRecord.version,
      activeCallId: activeCallId || null,
    });
  }

  if (eventType === 'CALL_ENDED' && safeSource.includes('billing') && nextRecord.state === 'online') {
    recordCallMetric('presence.contract.call_ended_to_online', 1, {
      source: safeSource,
      previousState: current.state,
      activeCall: activeCallId ? '1' : '0',
    });
  }

  if (nextRecord.state === 'on_call' && !activeCallId) {
    logWarning('creator_presence_on_call_without_active_call', {
      firebaseUid,
      eventType,
      source: safeSource,
      base: nextBase,
      activeCallId: activeCallId || null,
    });
  }

  return nextRecord;
}
