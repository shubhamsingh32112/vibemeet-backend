/**
 * Dashboard presence counts — Redis SETs + pipelined SCARD (no SCAN in hot paths).
 */
import { getRedis } from '../../config/redis';
import { Creator } from '../creator/creator.model';
import { User } from '../user/user.model';
import { getBatchCreatorPresence } from './presence.service';

export type CreatorPresenceBreakdown = {
  online: number;
  onCall: number;
  offline: number;
  total: number;
};

const PRESENCE_BREAKDOWN_CACHE_MS = 15_000;
let presenceBreakdownCache: { at: number; value: CreatorPresenceBreakdown } | null = null;

const PRESENCE_BATCH_SIZE = 200;

/** Resolve firebaseUid for each creator row (creator doc or linked user). */
async function resolveCreatorFirebaseUids(
  creators: Array<{ _id: unknown; firebaseUid?: string | null; userId?: { toString(): string } | null }>
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const missingUserIds: import('mongoose').Types.ObjectId[] = [];

  for (const c of creators) {
    const creatorId = String(c._id);
    const direct = c.firebaseUid?.trim();
    if (direct) {
      map.set(creatorId, direct);
      continue;
    }
    if (c.userId) {
      missingUserIds.push(c.userId as import('mongoose').Types.ObjectId);
    }
  }

  if (missingUserIds.length > 0) {
    const users = await User.find({ _id: { $in: missingUserIds } })
      .select('firebaseUid')
      .lean();
    const uidByUserId = new Map(
      users.map((u) => [u._id.toString(), u.firebaseUid?.trim() ?? ''])
    );
    for (const c of creators) {
      const creatorId = String(c._id);
      if (map.has(creatorId)) continue;
      const uid = c.userId ? uidByUserId.get(c.userId.toString()) : '';
      if (uid) map.set(creatorId, uid);
    }
  }

  return map;
}

async function countPresenceFromFirebaseUids(
  totalCreators: number,
  uidByCreatorId: Map<string, string>
): Promise<CreatorPresenceBreakdown> {
  const uids = [...uidByCreatorId.values()];
  const counts = { online: 0, onCall: 0, offline: 0 };

  for (let i = 0; i < uids.length; i += PRESENCE_BATCH_SIZE) {
    const batch = uids.slice(i, i + PRESENCE_BATCH_SIZE);
    const presence = await getBatchCreatorPresence(batch);
    for (const uid of batch) {
      const state = presence[uid]?.state ?? 'offline';
      if (state === 'online') counts.online += 1;
      else if (state === 'on_call') counts.onCall += 1;
      else counts.offline += 1;
    }
  }

  counts.offline += Math.max(0, totalCreators - uids.length);

  return {
    ...counts,
    total: totalCreators,
  };
}

/** Platform-wide Redis effective presence breakdown (admin source of truth). */
export async function countCreatorPresenceBreakdownPlatform(
  bypassCache = false
): Promise<CreatorPresenceBreakdown> {
  const now = Date.now();
  if (
    !bypassCache &&
    presenceBreakdownCache &&
    now - presenceBreakdownCache.at < PRESENCE_BREAKDOWN_CACHE_MS
  ) {
    return presenceBreakdownCache.value;
  }

  const creators = await Creator.find().select('_id firebaseUid userId').lean();
  const uidByCreatorId = await resolveCreatorFirebaseUids(creators);
  const value = await countPresenceFromFirebaseUids(creators.length, uidByCreatorId);
  presenceBreakdownCache = { at: now, value };
  return value;
}

/** Presence breakdown for creators matching a Mongo query (e.g. agency scope). */
export async function countCreatorPresenceBreakdownForQuery(
  creatorQuery: Record<string, unknown>
): Promise<CreatorPresenceBreakdown> {
  const creators = await Creator.find(creatorQuery).select('_id firebaseUid userId').lean();
  const uidByCreatorId = await resolveCreatorFirebaseUids(creators);
  return countPresenceFromFirebaseUids(creators.length, uidByCreatorId);
}

/** Filter creator IDs by Redis presence state before pagination. */
export async function filterCreatorIdsByPresence(
  creatorQuery: Record<string, unknown>,
  presenceStatus: 'online' | 'on_call' | 'offline'
): Promise<string[]> {
  const creators = await Creator.find(creatorQuery).select('_id firebaseUid userId').lean();
  const uidByCreatorId = await resolveCreatorFirebaseUids(creators);
  const allUids = [...uidByCreatorId.values()];

  const presenceByUid: Record<string, { state?: string }> = {};
  for (let i = 0; i < allUids.length; i += PRESENCE_BATCH_SIZE) {
    const batch = allUids.slice(i, i + PRESENCE_BATCH_SIZE);
    Object.assign(presenceByUid, await getBatchCreatorPresence(batch));
  }

  const matchingIds: string[] = [];
  for (const [creatorId, uid] of uidByCreatorId) {
    const state = uid ? presenceByUid[uid]?.state ?? 'offline' : 'offline';
    if (state === presenceStatus) matchingIds.push(creatorId);
  }
  for (const c of creators) {
    const id = String(c._id);
    if (!uidByCreatorId.has(id) && presenceStatus === 'offline') {
      matchingIds.push(id);
    }
  }

  return matchingIds;
}

export function invalidatePresenceBreakdownCache(): void {
  presenceBreakdownCache = null;
}

export const PRESENCE_ONLINE_CREATORS_SET = 'presence:online_creators';

export function presenceOnlineByBdKey(bdId: string): string {
  return `presence:online_by_bd:${bdId}`;
}

export function presenceOnlineByAgencyKey(bdId: string): string {
  return `presence:online_by_agency:${bdId}`;
}

/** Pipelined SCARD — mandatory for batch reads (single RTT). */
export async function pipelineScard(keys: string[]): Promise<number[]> {
  if (keys.length === 0) return [];
  const redis = getRedis();
  const pipeline = redis.pipeline();
  for (const key of keys) {
    pipeline.scard(key);
  }
  const results = await pipeline.exec();
  if (!results) return keys.map(() => 0);
  return results.map((row) => {
    const val = row?.[1];
    return typeof val === 'number' ? val : 0;
  });
}

export async function updateOnlinePresenceSets(
  firebaseUid: string,
  transition: 'online' | 'offline',
  scope: { bdId?: string; agencyId?: string }
): Promise<void> {
  const redis = getRedis();
  const pipeline = redis.pipeline();
  const sets = [PRESENCE_ONLINE_CREATORS_SET];
  if (scope.bdId) sets.push(presenceOnlineByBdKey(scope.bdId));
  if (scope.agencyId) sets.push(presenceOnlineByAgencyKey(scope.agencyId));

  for (const key of sets) {
    if (transition === 'online') {
      pipeline.sadd(key, firebaseUid);
    } else {
      pipeline.srem(key, firebaseUid);
    }
  }
  await pipeline.exec();
}

export async function countOnlineCreatorsPlatform(): Promise<number> {
  const redis = getRedis();
  return redis.scard(PRESENCE_ONLINE_CREATORS_SET);
}

export async function countOnlineCreatorsForAgency(bdId: string): Promise<number> {
  const redis = getRedis();
  return redis.scard(presenceOnlineByAgencyKey(bdId));
}

export async function countOnlineCreatorsForBd(bdId: string): Promise<number> {
  const redis = getRedis();
  return redis.scard(presenceOnlineByBdKey(bdId));
}

export async function countOnlineByAgencyIds(agencyIds: string[]): Promise<Map<string, number>> {
  const keys = agencyIds.map(presenceOnlineByAgencyKey);
  const counts = await pipelineScard(keys);
  const map = new Map<string, number>();
  agencyIds.forEach((id, i) => map.set(id, counts[i] ?? 0));
  return map;
}

export async function countOnlineByBdIds(bdIds: string[]): Promise<Map<string, number>> {
  const keys = bdIds.map(presenceOnlineByBdKey);
  const counts = await pipelineScard(keys);
  const map = new Map<string, number>();
  bdIds.forEach((id, i) => map.set(id, counts[i] ?? 0));
  return map;
}
