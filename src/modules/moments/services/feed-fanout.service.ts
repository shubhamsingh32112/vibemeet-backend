import mongoose from 'mongoose';
import { getRedis, isRedisConfigured } from '../../../config/redis';
import { getMomentsConfig } from '../../../config/moments';
import { CreatorFollow } from '../models/creator-follow.model';
import { CreatorMoment } from '../models/creator-moment.model';
import { logWarning } from '../../../utils/logger';
import { bumpStreamCounter, recordStreamMetric } from '../../stream/stream-metrics';
import {
  toMomentFeedDTO,
} from './moment-presentation.service';
import { loadFollowedCreatorIds } from './follow-context.service';

const FOLLOWING_PREFIX = 'feed:following:';
const FANOUT_QUEUE_KEY = 'moments:fanout:queue';
const FANOUT_DLQ_KEY = 'moments:fanout:dead_letter';
const WARM_QUEUE_KEY = 'moments:feed:warm:queue';

export function followingWarmCacheKey(userId: string, offset: number, limit: number): string {
  return `moments:following:warm:${userId}:${offset}:${limit}`;
}

/** Phase 2: populate on upload/follow. Phase 1: stub with cache helpers. */
export async function pushToFollowingFeedCache(
  followerUserId: string,
  momentId: string,
  score: number,
): Promise<void> {
  if (!isRedisConfigured()) return;
  const cfg = getMomentsConfig();
  const key = `${FOLLOWING_PREFIX}${followerUserId}`;
  const redis = getRedis();
  await redis.zadd(key, score, momentId);
  await redis.zremrangebyrank(key, 0, -501);
  await redis.expire(key, cfg.followingFeedCacheTtlSec);
}

export async function getFollowingFeedFromCache(
  userId: string,
  offset: number,
  limit: number,
): Promise<string[] | null> {
  if (!isRedisConfigured()) return null;
  const key = `${FOLLOWING_PREFIX}${userId}`;
  const redis = getRedis();
  const ids = await redis.zrevrange(key, offset, offset + limit - 1);
  if (!ids.length) return null;
  await redis.expire(key, getMomentsConfig().followingFeedCacheTtlSec);
  return ids;
}

export async function cacheFeedResponse(
  cacheKey: string,
  payload: string,
): Promise<void> {
  if (!isRedisConfigured()) return;
  const ttl = getMomentsConfig().feedCacheTtlSec;
  await getRedis().setex(cacheKey, ttl, payload);
}

export async function getCachedFeedResponse(cacheKey: string): Promise<string | null> {
  if (!isRedisConfigured()) return null;
  return getRedis().get(cacheKey);
}

export async function removeCreatorFromFollowingFeedCache(
  followerUserId: string,
  creatorId: string,
): Promise<void> {
  if (!isRedisConfigured()) return;
  const momentIds = await CreatorMoment.find({ creatorId }).select('_id').lean();
  if (!momentIds.length) return;
  const key = `${FOLLOWING_PREFIX}${followerUserId}`;
  const redis = getRedis();
  const pipeline = redis.pipeline();
  for (const m of momentIds) {
    pipeline.zrem(key, m._id.toString());
  }
  await pipeline.exec();
}

export function orderMomentsByIds(
  moments: Array<{ _id: mongoose.Types.ObjectId } & Record<string, unknown>>,
  ids: string[],
): typeof moments {
  const byId = new Map(moments.map((m) => [m._id.toString(), m]));
  return ids.map((id) => byId.get(id)).filter(Boolean) as typeof moments;
}

async function recordQueueDepths(): Promise<void> {
  if (!isRedisConfigured()) return;
  const redis = getRedis();
  const [fanoutDepth, warmDepth] = await Promise.all([
    redis.llen(FANOUT_QUEUE_KEY),
    redis.llen(WARM_QUEUE_KEY),
  ]);
  recordStreamMetric('feed.fanout.queue_depth', fanoutDepth);
  recordStreamMetric('feed.warm.queue_depth', warmDepth);
}

async function pushFanoutDeadLetter(
  raw: string,
  task: unknown,
  error: string,
): Promise<void> {
  if (!isRedisConfigured()) return;
  await getRedis().rpush(
    FANOUT_DLQ_KEY,
    JSON.stringify({ raw, task, error, ts: Date.now() }),
  );
}

export async function fanoutOnMomentUploaded(
  momentId: string,
  creatorId: string,
  score: number,
): Promise<void> {
  const cfg = getMomentsConfig();
  if (!cfg.fanoutOnUpload || !isRedisConfigured()) return;

  const startedAt = Date.now();
  const batchSize = 500;
  let lastId: mongoose.Types.ObjectId | null = null;
  let totalFollowers = 0;

  for (;;) {
    const query: Record<string, unknown> = { creatorId };
    if (lastId) query._id = { $gt: lastId };
    const batch = await CreatorFollow.find(query)
      .sort({ _id: 1 })
      .limit(batchSize)
      .select('followerUserId')
      .lean();
    if (!batch.length) break;

    const pipeline = getRedis().pipeline();
    for (const f of batch) {
      const key = `${FOLLOWING_PREFIX}${f.followerUserId.toString()}`;
      pipeline.zadd(key, score, momentId);
      pipeline.zremrangebyrank(key, 0, -501);
      pipeline.expire(key, cfg.followingFeedCacheTtlSec);
    }
    await pipeline.exec();
    totalFollowers += batch.length;
    lastId = batch[batch.length - 1]._id as mongoose.Types.ObjectId;
    if (batch.length < batchSize) break;
  }

  recordStreamMetric('feed.fanout.duration_ms', Date.now() - startedAt, {
    followers: String(totalFollowers),
  });

  if (cfg.feedWarmerEnabled) {
    const followerCount = await CreatorFollow.countDocuments({ creatorId });
    if (followerCount >= cfg.feedWarmerFollowerThreshold) {
      await enqueueFeedWarmTask(creatorId, momentId);
    }
  }
}

export async function enqueueFanoutTask(
  momentId: string,
  creatorId: string,
  score: number,
): Promise<void> {
  if (!isRedisConfigured()) {
    await fanoutOnMomentUploaded(momentId, creatorId, score);
    return;
  }
  await getRedis().rpush(
    FANOUT_QUEUE_KEY,
    JSON.stringify({ momentId, creatorId, score, ts: Date.now() }),
  );
}

async function enqueueFeedWarmTask(creatorId: string, momentId: string): Promise<void> {
  if (!isRedisConfigured()) return;
  await getRedis().rpush(
    WARM_QUEUE_KEY,
    JSON.stringify({ creatorId, momentId, ts: Date.now() }),
  );
}

export async function drainFanoutQueue(batchSize = 10): Promise<number> {
  if (!isRedisConfigured()) return 0;
  await recordQueueDepths();
  let processed = 0;
  for (let i = 0; i < batchSize; i++) {
    const raw = await getRedis().lpop(FANOUT_QUEUE_KEY);
    if (!raw) break;
    try {
      const task = JSON.parse(raw) as { momentId: string; creatorId: string; score: number };
      try {
        await fanoutOnMomentUploaded(task.momentId, task.creatorId, task.score);
        processed++;
      } catch (err) {
        bumpStreamCounter('feed.fanout.failed');
        await pushFanoutDeadLetter(raw, task, String(err));
        logWarning('Fanout task failed', { error: String(err), momentId: task.momentId });
      }
    } catch (err) {
      bumpStreamCounter('feed.fanout.dropped_parse');
      await pushFanoutDeadLetter(raw, null, String(err));
      logWarning('Fanout queue parse failed', { error: String(err), raw });
    }
  }
  return processed;
}

export async function drainFeedWarmQueue(batchSize = 5): Promise<number> {
  const cfg = getMomentsConfig();
  if (!cfg.feedWarmerEnabled || !isRedisConfigured()) return 0;

  await recordQueueDepths();
  let processed = 0;
  for (let i = 0; i < batchSize; i++) {
    const raw = await getRedis().lpop(WARM_QUEUE_KEY);
    if (!raw) break;
    try {
      const task = JSON.parse(raw) as { creatorId: string; momentId: string };
      try {
        await warmFollowingFeedForCreator(task.creatorId);
        processed++;
      } catch (err) {
        bumpStreamCounter('feed.warm.failed');
        logWarning('Feed warm task failed', { error: String(err), creatorId: task.creatorId });
      }
    } catch (err) {
      bumpStreamCounter('feed.warm.dropped_parse');
      logWarning('Feed warm queue parse failed', { error: String(err), raw });
    }
  }
  return processed;
}

async function warmFollowingFeedForCreator(creatorId: string): Promise<void> {
  const cfg = getMomentsConfig();
  const followers = await CreatorFollow.find({ creatorId })
    .sort({ createdAt: -1 })
    .limit(cfg.feedWarmerTopFollowers)
    .select('followerUserId')
    .lean();

  for (const f of followers) {
    const userId = f.followerUserId;
    const followedCreatorIds = await loadFollowedCreatorIds(userId);
    const viewer = { userId, followedCreatorIds };
    const limit = 20;
    const offset = 0;
    const cachedIds = await getFollowingFeedFromCache(userId.toString(), offset, limit);
    let moments;
    if (cachedIds) {
      moments = await CreatorMoment.find({
        _id: { $in: cachedIds },
        isDeleted: false,
        processingStatus: 'ready',
        moderationStatus: 'approved',
      });
      moments = orderMomentsByIds(moments, cachedIds);
    } else {
      continue;
    }
    const items = (
      await Promise.all(moments.map((m) => toMomentFeedDTO(m, viewer)))
    ).filter(Boolean);
    const payload = JSON.stringify({
      success: true,
      data: { items, hasMore: items.length >= limit, nextOffset: items.length },
    });
    const cacheKey = followingWarmCacheKey(userId.toString(), offset, limit);
    await cacheFeedResponse(cacheKey, payload);
    recordStreamMetric('feed.warm.ok', 1, { creatorId });
  }
}
