/**
 * Cache-like Redis ZSET for creator feed availability ordering.
 *
 * Redis key ownership:
 * - Key: creator:feed:rank:v1 (member = creatorId, score = rank)
 * - Owner: api-ws / creator-feed-rank.service
 * - TTL: none; cardinality bounded by CREATOR_FEED_AVAILABILITY_MAX_CATALOG
 * - Rebuild: startup (CREATOR_FEED_RANK_REBUILD=true) or operator only — never reactive loops
 * - Fallback: legacy in-memory sort in creator.controller (Mongo authoritative)
 */
import mongoose from 'mongoose';
import { Creator, CREATOR_LISTABLE_FILTER } from './creator.model';
import { User } from '../user/user.model';
import { getBatchCreatorPresence } from '../availability/presence.service';
import {
  CREATOR_FEED_RANK_KEY,
  getRedis,
  isRedisConfigured,
} from '../../config/redis';
import { logError, logInfo, logWarning } from '../../utils/logger';
import { recordFeedMetric } from '../../utils/monitoring';
import {
  isCreatorFeedRedisRankEnabled,
  isCreatorFeedRankShadowEnabled,
  readCreatorFeedAvailabilityMaxCatalog,
} from './creator-feed-rank-flags';
import { encodeFeedRankScore, type CreatorPresenceRankState } from './creator-feed-rank-score';

export { encodeFeedRankScore, type CreatorPresenceRankState };

const REBUILD_BATCH = 500;

export async function getCreatorFeedRankZcard(): Promise<number> {
  if (!isRedisConfigured()) return 0;
  try {
    return await getRedis().zcard(CREATOR_FEED_RANK_KEY);
  } catch {
    return 0;
  }
}

export async function clearCreatorFeedRankIndex(): Promise<void> {
  if (!isRedisConfigured()) return;
  await getRedis().del(CREATOR_FEED_RANK_KEY).catch(() => 0);
}

/** Operator/startup rebuild — streams Mongo catalog in batches. */
export async function rebuildCreatorFeedRankIndex(): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const cap = readCreatorFeedAvailabilityMaxCatalog();
  const redis = getRedis();
  await redis.del(CREATOR_FEED_RANK_KEY);

  const allowFallbackJoin = process.env.ENABLE_CREATOR_UID_FALLBACK_JOIN === 'true';
  let processed = 0;
  const cursor = Creator.find(CREATOR_LISTABLE_FILTER)
    .select('_id firebaseUid userId createdAt')
    .lean()
    .cursor();

  let batch: Array<{
    _id: mongoose.Types.ObjectId;
    firebaseUid?: string | null;
    userId?: mongoose.Types.ObjectId;
    createdAt: Date;
  }> = [];

  const flushBatch = async () => {
    if (batch.length === 0) return;
    const missingUserIds = allowFallbackJoin
      ? batch
          .filter((c) => !c.firebaseUid || String(c.firebaseUid).trim() === '')
          .map((c) => c.userId)
          .filter((id): id is mongoose.Types.ObjectId => Boolean(id))
      : [];
    const linked =
      allowFallbackJoin && missingUserIds.length
        ? await User.find({ _id: { $in: missingUserIds } }).select('_id firebaseUid').lean()
        : [];
    const uidByUserId = new Map(linked.map((u) => [u._id.toString(), u.firebaseUid ?? null]));

    const uids: string[] = [];
    const rows: Array<{ id: string; uid: string | null; createdAt: Date }> = [];
    for (const c of batch) {
      let uid =
        c.firebaseUid && String(c.firebaseUid).trim() !== ''
          ? String(c.firebaseUid).trim()
          : null;
      if (!uid && allowFallbackJoin && c.userId) {
        uid = uidByUserId.get(c.userId.toString()) ?? null;
      }
      rows.push({ id: c._id.toString(), uid, createdAt: c.createdAt });
      if (uid) uids.push(uid);
    }

    const presence = uids.length > 0 ? await getBatchCreatorPresence(uids) : {};
    const pipeline = redis.pipeline();
    for (const row of rows) {
      if (processed >= cap) break;
      const state = row.uid ? presence[row.uid]?.state : 'offline';
      const score = encodeFeedRankScore(state, row.createdAt.getTime());
      pipeline.zadd(CREATOR_FEED_RANK_KEY, score, row.id);
      processed += 1;
    }
    await pipeline.exec().catch((err) => logError('creator.feed.rank_rebuild_batch_failed', err, {}));
    batch = [];
  };

  for await (const doc of cursor) {
    if (processed >= cap) break;
    batch.push(doc);
    if (batch.length >= REBUILD_BATCH) {
      await flushBatch();
    }
  }
  await flushBatch();

  logInfo('creator.feed.rank_rebuild_complete', { processed, cap });
  recordFeedMetric('creator_feed_rank_rebuild_count', processed, {});
  return processed;
}

export async function updateCreatorFeedRankOnPresence(
  creatorId: string,
  firebaseUid: string,
  state: CreatorPresenceRankState,
  createdAtMs: number
): Promise<void> {
  if (!isRedisConfigured() || !isCreatorFeedRedisRankEnabled()) return;
  try {
    const score = encodeFeedRankScore(state, createdAtMs);
    await getRedis().zadd(CREATOR_FEED_RANK_KEY, score, creatorId);
    recordFeedMetric('creator_feed_rank_presence_update', 1, { state });
  } catch (err) {
    logError('creator.feed.rank_presence_update_failed', err, { creatorId, firebaseUid });
  }
}

export async function removeCreatorFromFeedRank(creatorId: string): Promise<void> {
  if (!isRedisConfigured()) return;
  await getRedis().zrem(CREATOR_FEED_RANK_KEY, creatorId).catch(() => 0);
}

export type AvailabilityFeedRankPage = {
  pageIds: mongoose.Types.ObjectId[];
  total: number;
  usedRankIndex: boolean;
  degradedToCreatedAt: boolean;
};

export async function getAvailabilityFeedPageFromRank(
  skip: number,
  limit: number
): Promise<AvailabilityFeedRankPage | null> {
  if (!isRedisConfigured() || !isCreatorFeedRedisRankEnabled()) return null;

  const redis = getRedis();
  const zcard = await redis.zcard(CREATOR_FEED_RANK_KEY);
  if (zcard === 0) {
    return null;
  }

  const cap = readCreatorFeedAvailabilityMaxCatalog();
  const total = Math.min(zcard, cap);
  if (total > cap) {
    logWarning('creator.feed.availability_catalog_capped', { count: total, cap });
    recordFeedMetric('creator_feed_availability_catalog_capped', 1, { cap: String(cap) });
  }

  const ids = await redis.zrange(CREATOR_FEED_RANK_KEY, skip, skip + limit - 1);
  const pageIds = ids.map((id) => new mongoose.Types.ObjectId(id));

  return {
    pageIds,
    total,
    usedRankIndex: true,
    degradedToCreatedAt: false,
  };
}

/** Shadow compare first page order vs legacy — telemetry only. */
export async function recordFeedRankShadowMismatchIfNeeded(
  legacyIds: string[],
  rankIds: string[]
): Promise<void> {
  if (!isCreatorFeedRankShadowEnabled()) return;
  const sampleLen = Math.min(legacyIds.length, rankIds.length, 20);
  let mismatches = 0;
  for (let i = 0; i < sampleLen; i += 1) {
    if (legacyIds[i] !== rankIds[i]) mismatches += 1;
  }
  if (mismatches > 0) {
    recordFeedMetric('creator_feed_rank_shadow_mismatch', mismatches, {});
  }
}
