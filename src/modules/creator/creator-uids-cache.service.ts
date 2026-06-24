/**
 * Creator Firebase UID catalog cache.
 *
 * Redis key ownership (Phase 4):
 * - Key: creator:uids:set:v1
 * - Owner: api-ws / creator controller
 * - TTL: CREATOR_UIDS_TTL on JSON snapshot; SET refreshed on catalog invalidation
 * - Rebuild: startup/operator or single miss path with lock — never reactive rebuild loops
 * - Fallback: Mongo cursor stream on cache miss
 */
import mongoose from 'mongoose';
import { Creator, CREATOR_LISTABLE_FILTER } from './creator.model';
import { User } from '../user/user.model';
import {
  CREATOR_UIDS_CACHE_KEY,
  CREATOR_UIDS_SET_KEY,
  CREATOR_UIDS_REBUILD_LOCK_KEY,
  CREATOR_UIDS_TTL,
  getRedis,
  isRedisConfigured,
} from '../../config/redis';
import { safeRedisGet, safeRedisSet } from '../../utils/redis-circuit-breaker';
import { logError, logInfo } from '../../utils/logger';

const REBUILD_LOCK_TTL_SEC = 120;
const CURSOR_BATCH = 500;

async function resolveUidFromRow(
  row: { firebaseUid?: string | null; userId?: mongoose.Types.ObjectId },
  allowFallbackJoin: boolean,
  uidByUserId: Map<string, string | null>
): Promise<string | null> {
  const direct = row.firebaseUid;
  if (typeof direct === 'string') {
    const trimmed = direct.trim();
    if (trimmed.length > 0) return trimmed;
  }
  if (!allowFallbackJoin || !row.userId) return null;
  const fallback = uidByUserId.get(row.userId.toString()) ?? null;
  if (typeof fallback === 'string' && fallback.trim().length > 0) return fallback.trim();
  return null;
}

/** Stream catalog UIDs from Mongo — bounded memory via cursor batches. */
export async function streamCreatorFirebaseUidsFromMongo(): Promise<string[]> {
  const allowFallbackJoin = process.env.ENABLE_CREATOR_UID_FALLBACK_JOIN === 'true';
  const uidSet = new Set<string>();
  const missingUidUserIds: mongoose.Types.ObjectId[] = [];
  const pendingRows: Array<{ firebaseUid?: string | null; userId?: mongoose.Types.ObjectId }> = [];

  const cursor = Creator.find(CREATOR_LISTABLE_FILTER)
    .select(allowFallbackJoin ? 'firebaseUid userId' : 'firebaseUid')
    .lean()
    .cursor();

  for await (const row of cursor) {
    const direct =
      typeof row.firebaseUid === 'string' ? row.firebaseUid.trim() : '';
    if (direct.length > 0) {
      uidSet.add(direct);
      continue;
    }
    if (allowFallbackJoin && row.userId) {
      pendingRows.push(row);
      missingUidUserIds.push(row.userId);
      if (missingUidUserIds.length >= CURSOR_BATCH) {
        const linked = await User.find({ _id: { $in: missingUidUserIds } })
          .select('_id firebaseUid')
          .lean();
        const uidByUserId = new Map(
          linked.map((u) => [u._id.toString(), u.firebaseUid ?? null] as const)
        );
        for (const pending of pendingRows) {
          const uid = await resolveUidFromRow(pending, true, uidByUserId);
          if (uid) uidSet.add(uid);
        }
        missingUidUserIds.length = 0;
        pendingRows.length = 0;
      }
    }
  }

  if (allowFallbackJoin && missingUidUserIds.length > 0) {
    const linked = await User.find({ _id: { $in: missingUidUserIds } })
      .select('_id firebaseUid')
      .lean();
    const uidByUserId = new Map(
      linked.map((u) => [u._id.toString(), u.firebaseUid ?? null] as const)
    );
    for (const pending of pendingRows) {
      const uid = await resolveUidFromRow(pending, true, uidByUserId);
      if (uid) uidSet.add(uid);
    }
  }

  return Array.from(uidSet);
}

async function writeUidCaches(firebaseUids: string[]): Promise<void> {
  if (!isRedisConfigured()) return;
  const redis = getRedis();
  await safeRedisSet(CREATOR_UIDS_CACHE_KEY, JSON.stringify({ firebaseUids }), {
    ex: CREATOR_UIDS_TTL,
  });
  const pipeline = redis.pipeline();
  pipeline.del(CREATOR_UIDS_SET_KEY);
  if (firebaseUids.length > 0) {
    pipeline.sadd(CREATOR_UIDS_SET_KEY, ...firebaseUids);
  }
  pipeline.expire(CREATOR_UIDS_SET_KEY, CREATOR_UIDS_TTL);
  await pipeline.exec().catch((err) => logError('creator.uids.set_write_failed', err, {}));
}

export async function getCreatorFirebaseUidsCached(): Promise<{
  firebaseUids: string[];
  cacheHit: boolean;
}> {
  if (isRedisConfigured()) {
    const cached = await safeRedisGet<{ firebaseUids: string[] }>(CREATOR_UIDS_CACHE_KEY);
    if (cached?.firebaseUids && Array.isArray(cached.firebaseUids)) {
      return { firebaseUids: cached.firebaseUids, cacheHit: true };
    }
    const redis = getRedis();
    const setMembers = await redis.smembers(CREATOR_UIDS_SET_KEY).catch(() => [] as string[]);
    if (setMembers.length > 0) {
      const firebaseUids = setMembers.filter((u) => typeof u === 'string' && u.trim().length > 0);
      await safeRedisSet(CREATOR_UIDS_CACHE_KEY, JSON.stringify({ firebaseUids }), {
        ex: CREATOR_UIDS_TTL,
      });
      return { firebaseUids, cacheHit: true };
    }
  }

  if (isRedisConfigured()) {
    const redis = getRedis();
    const locked = await redis
      .set(CREATOR_UIDS_REBUILD_LOCK_KEY, '1', 'EX', REBUILD_LOCK_TTL_SEC, 'NX')
      .catch(() => null);
    if (!locked) {
      const retry = await safeRedisGet<{ firebaseUids: string[] }>(CREATOR_UIDS_CACHE_KEY);
      if (retry?.firebaseUids) {
        return { firebaseUids: retry.firebaseUids, cacheHit: true };
      }
    }
  }

  const firebaseUids = await streamCreatorFirebaseUidsFromMongo();
  await writeUidCaches(firebaseUids);
  if (isRedisConfigured()) {
    await getRedis().del(CREATOR_UIDS_REBUILD_LOCK_KEY).catch(() => 0);
  }
  return { firebaseUids, cacheHit: false };
}

export async function addCreatorFirebaseUidToCache(firebaseUid: string): Promise<void> {
  const trimmed = firebaseUid.trim();
  if (!trimmed || !isRedisConfigured()) return;
  try {
    const redis = getRedis();
    await redis.sadd(CREATOR_UIDS_SET_KEY, trimmed);
    await redis.expire(CREATOR_UIDS_SET_KEY, CREATOR_UIDS_TTL);
    await redis.del(CREATOR_UIDS_CACHE_KEY);
  } catch (err) {
    logError('creator.uids.incremental_add_failed', err, { firebaseUid: trimmed });
  }
}

export async function removeCreatorFirebaseUidFromCache(firebaseUid: string): Promise<void> {
  const trimmed = firebaseUid.trim();
  if (!trimmed || !isRedisConfigured()) return;
  try {
    const redis = getRedis();
    await redis.srem(CREATOR_UIDS_SET_KEY, trimmed);
    await redis.del(CREATOR_UIDS_CACHE_KEY);
  } catch (err) {
    logError('creator.uids.incremental_remove_failed', err, { firebaseUid: trimmed });
  }
}

export async function invalidateCreatorUidsCacheFull(): Promise<void> {
  if (!isRedisConfigured()) return;
  try {
    const redis = getRedis();
    await redis.del(CREATOR_UIDS_CACHE_KEY, CREATOR_UIDS_SET_KEY, CREATOR_UIDS_REBUILD_LOCK_KEY);
    logInfo('Invalidated creator UIDs cache and set');
  } catch (err) {
    logError('Failed to invalidate creator UIDs cache', err);
  }
}
