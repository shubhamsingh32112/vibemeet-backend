/**
 * Creator presence audit — startup and periodic summaries for redeploy diagnostics.
 *
 * After a deploy, in-memory socket tracking is empty while Redis may still show
 * creators as online/on_call until TTL expires or they reconnect. These logs make
 * that drift visible in Railway/console logs.
 */
import { Server } from 'socket.io';
import {
  getRedis,
  isRedisConfigured,
  AVAILABILITY_KEY_PREFIX,
  ACTIVE_CALL_BY_USER_PREFIX,
  availabilityKey,
  activeCallByUserKey,
} from '../../config/redis';
import { getBatchCreatorPresence } from './presence.service';
import { countOnlineCreatorsPlatform } from './presence-dashboard.service';
import { logInfo, logWarning, logError } from '../../utils/logger';
import { recordCallMetric } from '../../utils/monitoring';

const PRESENCE_TTL_SECONDS = Math.min(
  600,
  Math.max(90, parseInt(process.env.CREATOR_PRESENCE_TTL_SECONDS || '180', 10) || 180)
);

const STALE_META_AGE_MS = Math.min(
  600_000,
  Math.max(
    PRESENCE_TTL_SECONDS * 1000,
    parseInt(process.env.CREATOR_PRESENCE_STALE_META_AGE_MS || String(PRESENCE_TTL_SECONDS * 1000), 10) ||
      PRESENCE_TTL_SECONDS * 1000
  )
);

const STARTUP_AUDIT_SAMPLE_LIMIT = Math.min(
  10,
  Math.max(1, parseInt(process.env.CREATOR_PRESENCE_STARTUP_AUDIT_SAMPLE || '5', 10) || 5)
);

export type CreatorPresenceAuditCounts = {
  scannedAvailabilityKeys: number;
  scannedActiveCallSlots: number;
  effectiveOnline: number;
  effectiveOnCall: number;
  effectiveOffline: number;
  baseOnline: number;
  baseOffline: number;
  presenceSetOnline: number;
  connectedCreatorSockets: number;
  /** Redis says online/on_call but no live creator socket on this process */
  staleWithoutSocket: number;
  /** Meta updatedAt older than stale threshold (likely ghost from prior deploy) */
  staleByMetaAge: number;
};

export type CreatorPresenceStaleSample = {
  firebaseUid: string;
  state: 'online' | 'on_call';
  base: 'online' | 'offline';
  metaAgeMs: number;
  activeCallId: string | null;
  source: string;
  reason: 'no_socket' | 'meta_age' | 'both';
};

function parseUidFromKey(key: string, prefix: string): string | null {
  if (!key.startsWith(prefix)) return null;
  const uid = key.slice(prefix.length).trim();
  return uid.length > 0 ? uid : null;
}

function countConnectedCreatorSockets(io: Server | undefined): number {
  if (!io) return 0;
  const uids = new Set<string>();
  for (const [, socket] of io.sockets.sockets) {
    if (!socket.connected) continue;
    const uid = socket.data.firebaseUid as string | undefined;
    if (!uid || !socket.data.isCreator) continue;
    uids.add(uid);
  }
  return uids.size;
}

function connectedCreatorUidSet(io: Server | undefined): Set<string> {
  const uids = new Set<string>();
  if (!io) return uids;
  for (const [, socket] of io.sockets.sockets) {
    if (!socket.connected) continue;
    const uid = socket.data.firebaseUid as string | undefined;
    if (!uid || !socket.data.isCreator) continue;
    uids.add(uid);
  }
  return uids;
}

/**
 * Scan Redis creator presence and log a redeploy-friendly summary.
 * Safe to call on every process start (uses SCAN, bounded samples).
 */
export async function auditCreatorPresenceOnStartup(
  io?: Server,
  context: string = 'server.startup'
): Promise<CreatorPresenceAuditCounts> {
  const empty: CreatorPresenceAuditCounts = {
    scannedAvailabilityKeys: 0,
    scannedActiveCallSlots: 0,
    effectiveOnline: 0,
    effectiveOnCall: 0,
    effectiveOffline: 0,
    baseOnline: 0,
    baseOffline: 0,
    presenceSetOnline: 0,
    connectedCreatorSockets: 0,
    staleWithoutSocket: 0,
    staleByMetaAge: 0,
  };

  if (!isRedisConfigured()) {
    logInfo('creator_presence_startup_audit_skipped', { reason: 'redis_not_configured', context });
    return empty;
  }

  const startedAt = Date.now();
  const redis = getRedis();
  const connectedUids = connectedCreatorUidSet(io);
  const connectedCreatorSockets = connectedUids.size;

  const availabilityUids = new Set<string>();
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${AVAILABILITY_KEY_PREFIX}*`,
      'COUNT',
      100
    );
    cursor = nextCursor;
    for (const key of keys) {
      const uid = parseUidFromKey(key, AVAILABILITY_KEY_PREFIX);
      if (uid) availabilityUids.add(uid);
    }
  } while (cursor !== '0');

  const activeCallUids = new Set<string>();
  cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${ACTIVE_CALL_BY_USER_PREFIX}*`,
      'COUNT',
      100
    );
    cursor = nextCursor;
    for (const key of keys) {
      const uid = parseUidFromKey(key, ACTIVE_CALL_BY_USER_PREFIX);
      if (uid) activeCallUids.add(uid);
    }
  } while (cursor !== '0');

  const allUids = new Set<string>([...availabilityUids, ...activeCallUids]);
  const uidList = Array.from(allUids);

  let baseOnline = 0;
  let baseOffline = 0;
  if (uidList.length > 0) {
    const baseVals = await redis.mget(...uidList.map((id) => availabilityKey(id)));
    uidList.forEach((_, idx) => {
      const raw = baseVals[idx];
      if (raw === 'online') baseOnline += 1;
      else baseOffline += 1;
    });
  }

  const presence = uidList.length > 0 ? await getBatchCreatorPresence(uidList) : {};

  let effectiveOnline = 0;
  let effectiveOnCall = 0;
  let effectiveOffline = 0;
  let staleWithoutSocket = 0;
  let staleByMetaAge = 0;
  const staleSamples: CreatorPresenceStaleSample[] = [];
  const now = Date.now();

  for (const uid of uidList) {
    const rec = presence[uid];
    const state = rec?.state ?? 'offline';
    if (state === 'online') effectiveOnline += 1;
    else if (state === 'on_call') effectiveOnCall += 1;
    else effectiveOffline += 1;

    if (state !== 'online' && state !== 'on_call') continue;

    const metaAgeMs = Math.max(0, now - (rec?.updatedAt ?? now));
    const noSocket = !connectedUids.has(uid);
    const metaStale = metaAgeMs >= STALE_META_AGE_MS;
    if (!noSocket && !metaStale) continue;

    if (noSocket) staleWithoutSocket += 1;
    if (metaStale) staleByMetaAge += 1;

    if (staleSamples.length < STARTUP_AUDIT_SAMPLE_LIMIT) {
      const baseRaw = await redis.get(availabilityKey(uid));
      const activeCallId = await redis.get(activeCallByUserKey(uid));
      staleSamples.push({
        firebaseUid: uid,
        state,
        base: baseRaw === 'online' ? 'online' : 'offline',
        metaAgeMs,
        activeCallId: activeCallId || null,
        source: rec?.source ?? 'unknown',
        reason: noSocket && metaStale ? 'both' : noSocket ? 'no_socket' : 'meta_age',
      });
    }
  }

  let presenceSetOnline = 0;
  try {
    presenceSetOnline = await countOnlineCreatorsPlatform();
  } catch (err) {
    logError('creator_presence_startup_audit_presence_set_failed', err, { context });
  }

  const counts: CreatorPresenceAuditCounts = {
    scannedAvailabilityKeys: availabilityUids.size,
    scannedActiveCallSlots: activeCallUids.size,
    effectiveOnline,
    effectiveOnCall,
    effectiveOffline,
    baseOnline,
    baseOffline,
    presenceSetOnline,
    connectedCreatorSockets,
    staleWithoutSocket,
    staleByMetaAge,
  };

  recordCallMetric('presence.startup_audit.online', effectiveOnline, { context });
  recordCallMetric('presence.startup_audit.on_call', effectiveOnCall, { context });
  recordCallMetric('presence.startup_audit.stale_no_socket', staleWithoutSocket, { context });
  recordCallMetric('presence.startup_audit.stale_meta_age', staleByMetaAge, { context });

  const presenceSetDrift = Math.abs(presenceSetOnline - effectiveOnline);

  logInfo('creator_presence_state_now', {
    context,
    ...counts,
    uniqueCreatorsScanned: uidList.length,
    presenceSetDriftFromEffectiveOnline: presenceSetDrift,
    staleMetaThresholdMs: STALE_META_AGE_MS,
    durationMs: Date.now() - startedAt,
  });

  if (staleWithoutSocket > 0 || staleByMetaAge > 0 || presenceSetDrift > 0) {
    logWarning('creator_presence_stale_after_deploy', {
      context,
      staleWithoutSocket,
      staleByMetaAge,
      presenceSetDrift,
      effectiveOnline,
      effectiveOnCall,
      connectedCreatorSockets,
      sample: staleSamples,
      hint:
        'Redis still shows creators online/on_call but this process has no matching sockets yet (normal right after redeploy until TTL or reconnect).',
    });
  } else {
    logInfo('creator_presence_startup_audit_clean', {
      context,
      effectiveOnline,
      effectiveOnCall,
      connectedCreatorSockets,
    });
  }

  return counts;
}

/** Log aggregate counts after gateway cleanup sweeps (non-blocking). */
export function logCreatorPresenceSweepSummary(
  label: string,
  details: {
    creatorsForcedOffline?: number;
    usersForcedOffline?: number;
    creatorHeartbeatStale?: number;
    userHeartbeatStale?: number;
  }
): void {
  const total =
    (details.creatorsForcedOffline ?? 0) +
    (details.creatorHeartbeatStale ?? 0);
  if (total === 0 && (details.usersForcedOffline ?? 0) === 0) {
    logInfo('creator_presence_sweep_no_changes', { label, ...details });
    return;
  }
  logInfo('creator_presence_sweep_applied', { label, ...details });
}
