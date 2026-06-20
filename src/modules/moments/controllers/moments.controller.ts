import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { User } from '../../user/user.model';
import { Creator } from '../../creator/creator.model';
import { assertMomentsEnabled, respondMomentsDisabled } from '../../../config/moments';
import { CreatorMoment } from '../models/creator-moment.model';
import { MomentView } from '../models/moment-view.model';
import { CreatorFollow } from '../models/creator-follow.model';
import { MomentRevenue } from '../models/moment-revenue.model';
import { commitImageAsset, CommitImageAssetError } from '../../images/commit-image-asset';
import { CloudflareImagesError } from '../../images/cloudflare.client';
import { consumeStreamUploadSession } from '../../stream/stream-upload-session.service';
import {
  defaultModerationStatus,
  resolvePriceCoins,
  toCreatorSelfMomentDTO,
  toMomentFeedDTO,
  toMomentPresentationDTO,
} from '../services/moment-presentation.service';
import { toFeedDTO } from '../dto/moment.dto';
import { purchaseMoment, PurchaseInProgressError } from '../services/purchase.service';
import { checkMomentsRateLimit } from '../services/moments-rate-limit.service';
import { emitMomentViewed, emitMomentCompleted } from '../services/analytics-emitter.service';
import {
  cacheFeedResponse,
  followingWarmCacheKey,
  getCachedFeedResponse,
  getFollowingFeedFromCache,
  pushToFollowingFeedCache,
  enqueueFanoutTask,
  orderMomentsByIds,
  removeCreatorFromFollowingFeedCache,
  removeMomentFromFollowerFeeds,
  bustPopularFeedCacheForUser,
  bustFollowingWarmCacheForUser,
} from '../services/feed-fanout.service';
import { logError } from '../../../utils/logger';
import { emitMomentUploaded, emitMomentPurchased, emitMomentPurchaseCountToCreator, emitCreatorFollowed } from '../moments.gateway';
import {
  getPlaybackTokenExpiresAtMs,
  isStreamSigningConfigured,
} from '../../stream/signed-token.service';
import { recordPlaybackRefreshMetric } from '../../stream/stream-metrics';
import {
  countCreatorFollowers,
  countCreatorFollowing,
  isUserFollowingCreator,
  loadFollowedCreatorIds,
} from '../services/follow-context.service';
import { creditMomentUploadReward } from '../services/moment-upload-reward.service';

async function resolveUser(req: Request) {
  if (!req.auth?.firebaseUid) return null;
  return User.findOne({ firebaseUid: req.auth.firebaseUid });
}

async function resolveCreator(userId: mongoose.Types.ObjectId) {
  return Creator.findOne({ userId });
}

async function recordUniqueMomentView(
  userId: mongoose.Types.ObjectId,
  moment: InstanceType<typeof CreatorMoment>,
): Promise<number> {
  const creator = await resolveCreator(userId);
  if (creator && moment.creatorId.equals(creator._id)) {
    return moment.viewsCount;
  }

  const existing = await MomentView.findOne({
    momentId: moment._id,
    viewerUserId: userId,
  });
  if (!existing) {
    await MomentView.create({
      momentId: moment._id,
      viewerUserId: userId,
    });
    await CreatorMoment.updateOne({ _id: moment._id }, { $inc: { viewsCount: 1 } });
    moment.viewsCount += 1;
    await emitMomentViewed(userId.toString(), moment._id.toString());
  }

  return moment.viewsCount;
}

function publicMomentQuery(extra: Record<string, unknown> = {}) {
  return {
    isDeleted: false,
    processingStatus: 'ready',
    moderationStatus: 'approved',
    ...extra,
  };
}

export async function createMomentHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const rate = await checkMomentsRateLimit('upload', user._id.toString());
    if (!rate.allowed) {
      res.status(429).json({ success: false, error: 'Upload rate limit exceeded', retryAfterSec: rate.retryAfterSec });
      return;
    }
    const creator = await resolveCreator(user._id);
    if (!creator) {
      res.status(403).json({ success: false, error: 'Creators only' });
      return;
    }

    const {
      type,
      accessType = 'free',
      caption,
      imageSessionId,
      streamSessionId,
      thumbnailSessionId,
    } = req.body as {
      type: 'photo' | 'video';
      accessType?: 'free' | 'paid';
      caption?: string;
      imageSessionId?: string;
      streamSessionId?: string;
      thumbnailSessionId?: string;
    };

    if (type !== 'photo' && type !== 'video') {
      res.status(400).json({ success: false, error: 'Invalid type' });
      return;
    }

    const priceCoins = resolvePriceCoins(type, accessType === 'paid' ? 'paid' : 'free');

    const moment = await CreatorMoment.create({
      creatorId: creator._id,
      type,
      accessType: accessType === 'paid' ? 'paid' : 'free',
      priceCoins,
      feedScore: Date.now(),
      caption: caption?.trim() || null,
      processingStatus: 'uploading',
      moderationStatus: defaultModerationStatus(),
    });

    if (type === 'photo' && imageSessionId) {
      const committed = await commitImageAsset({
        sessionId: imageSessionId,
        userId: user._id.toString(),
        userObjectId: user._id,
        purpose: 'moment-photo',
        quotaScope: 'moments',
        blurhashTarget: { kind: 'moment-image', momentId: moment._id.toString() },
      });
      moment.imageAsset = committed.asset;
      moment.processingStatus = 'ready';
      await moment.save();
    } else if (type === 'video' && streamSessionId) {
      const session = await consumeStreamUploadSession(
        streamSessionId,
        user._id.toString(),
        'moment',
      );
      if (!session) {
        await CreatorMoment.deleteOne({ _id: moment._id });
        res.status(400).json({ success: false, error: 'Invalid stream session' });
        return;
      }
      moment.streamVideoId = session.streamVideoId;
      moment.durationSeconds = session.durationSeconds ?? null;
      if (thumbnailSessionId) {
        const thumb = await commitImageAsset({
          sessionId: thumbnailSessionId,
          userId: user._id.toString(),
          userObjectId: user._id,
          purpose: 'moment-thumbnail',
          quotaScope: 'moments',
          blurhashTarget: { kind: 'moment-image', momentId: moment._id.toString() },
          skipQuotaRecord: true,
        });
        moment.thumbnailAsset = thumb.asset;
      }
      moment.processingStatus = 'ready';
      await moment.save();
    } else {
      await CreatorMoment.deleteOne({ _id: moment._id });
      res.status(400).json({ success: false, error: 'Missing upload session' });
      return;
    }

    emitMomentUploaded(creator._id.toString(), moment._id.toString());
    void enqueueFanoutTask(moment._id.toString(), creator._id.toString(), moment.feedScore);

    let uploadRewardCoins = 0;
    try {
      const uploadReward = await creditMomentUploadReward({
        userId: user._id,
        creatorId: creator._id,
        momentId: moment._id.toString(),
        momentType: type,
      });
      uploadRewardCoins = uploadReward?.coinsCredited ?? 0;
    } catch (rewardError) {
      logError('Moment upload reward failed (moment saved)', rewardError);
    }

    const momentDto = await toCreatorSelfMomentDTO(moment, {
      userId: user._id,
      isCreatorOwner: true,
    });
    res.status(201).json({
      success: true,
      data: momentDto
        ? { ...momentDto, uploadRewardCoins }
        : {
            id: moment._id.toString(),
            creatorId: creator._id.toString(),
            uploadRewardCoins,
          },
    });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    if (error instanceof CommitImageAssetError) {
      res.status(error.status).json({ success: false, error: error.message });
      return;
    }
    if (error instanceof CloudflareImagesError) {
      res.status(error.status >= 500 ? 502 : error.status).json({
        success: false,
        error: 'Image processing failed',
        code: 'CLOUDFLARE_IMAGES_ERROR',
      });
      return;
    }
    logError('Create moment failed', error);
    res.status(500).json({ success: false, error: 'Failed to create moment' });
  }
}

export async function getMomentsFeedHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    const user = await resolveUser(req);
    const followedCreatorIds = await loadFollowedCreatorIds(user?._id ?? null);
    const viewer = { userId: user?._id ?? null, followedCreatorIds };
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const cursor = req.query.cursor as string | undefined;

    const cacheKey = `moments:feed:${user?._id || 'anon'}:${cursor || '0'}:${limit}`;
    const cached = await getCachedFeedResponse(cacheKey);
    if (cached) {
      res.json(JSON.parse(cached));
      return;
    }

    const query = publicMomentQuery();
    if (cursor) {
      const cursorDate = new Date(cursor);
      Object.assign(query, { feedScore: { $lt: cursorDate.getTime() } });
    }

    const moments = await CreatorMoment.find(query)
      .sort({ feedScore: -1, _id: -1 })
      .limit(limit + 1);

    const slice = moments.slice(0, limit);
    const items = (
      await Promise.all(slice.map((m) => toMomentFeedDTO(m, viewer)))
    ).filter(Boolean);

    const nextCursor =
      moments.length > limit ? String(slice[slice.length - 1]?.feedScore) : undefined;

    const payload = { success: true, data: { items, nextCursor } };
    await cacheFeedResponse(cacheKey, JSON.stringify(payload));
    res.json(payload);
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    logError('Moments feed failed', error);
    res.status(500).json({ success: false, error: 'Failed to load feed' });
  }
}

export async function getFollowingMomentsFeedHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const offset = Number(req.query.offset) || 0;
    const followedCreatorIds = await loadFollowedCreatorIds(user._id);
    const viewer = { userId: user._id, followedCreatorIds };

    const warmKey = followingWarmCacheKey(user._id.toString(), offset, limit);
    const warmCached = await getCachedFeedResponse(warmKey);
    if (warmCached) {
      res.json(JSON.parse(warmCached));
      return;
    }

    const cachedIds = await getFollowingFeedFromCache(user._id.toString(), offset, limit);
    let moments;
    if (cachedIds) {
      const found = await CreatorMoment.find({
        _id: { $in: cachedIds },
        ...publicMomentQuery(),
      });
      moments = orderMomentsByIds(found, cachedIds);
    } else {
      const follows = await CreatorFollow.find({ followerUserId: user._id }).select('creatorId');
      const creatorIds = follows.map((f) => f.creatorId);
      moments = await CreatorMoment.find({
        creatorId: { $in: creatorIds },
        ...publicMomentQuery(),
      })
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit);
    }

    const items = (
      await Promise.all(moments.map((m) => toMomentFeedDTO(m, viewer)))
    ).filter(Boolean);
    const hasMore = moments.length >= limit;
    res.json({ success: true, data: { items, hasMore, nextOffset: offset + items.length } });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    logError('Following feed failed', error);
    res.status(500).json({ success: false, error: 'Failed to load following feed' });
  }
}

export async function recordMomentViewHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const rate = await checkMomentsRateLimit('storyView', user._id.toString());
    if (!rate.allowed) {
      res.status(429).json({ success: false, error: 'Rate limit exceeded' });
      return;
    }
    const moment = await CreatorMoment.findById(req.params.momentId);
    if (!moment || moment.isDeleted) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    const viewsCount = await recordUniqueMomentView(user._id, moment);
    res.json({ success: true, data: { viewsCount } });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    logError('Record moment view failed', error);
    res.status(500).json({ success: false, error: 'Failed to record view' });
  }
}

export async function getMomentDetailHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    const user = await resolveUser(req);
    const moment = await CreatorMoment.findById(req.params.momentId);
    if (!moment) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    const dto = await toMomentPresentationDTO(moment, { userId: user?._id ?? null });
    if (!dto) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    if (user) {
      await recordUniqueMomentView(user._id, moment);
    }
    res.json({ success: true, data: dto });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    logError('Get moment failed', error);
    res.status(500).json({ success: false, error: 'Failed to load moment' });
  }
}

export async function purchaseMomentHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const rate = await checkMomentsRateLimit('purchase', user._id.toString());
    if (!rate.allowed) {
      res.status(429).json({ success: false, error: 'Too many purchase attempts', retryAfterSec: rate.retryAfterSec });
      return;
    }
    const dto = await purchaseMoment({
      userId: user._id,
      momentId: req.params.momentId,
      transactionId: req.body?.transactionId,
    });
    const moment = await CreatorMoment.findById(req.params.momentId);
    if (user.firebaseUid) {
      emitMomentPurchased(user.firebaseUid, {
        momentId: req.params.momentId,
        buyerUserId: user._id.toString(),
        purchaseCount: moment?.purchaseCount ?? 0,
        item: toFeedDTO(dto) as unknown as Record<string, unknown>,
      });
    }
    if (moment) {
      const creator = await Creator.findById(moment.creatorId);
      if (creator) {
        const creatorUser = await User.findById(creator.userId);
        if (creatorUser?.firebaseUid) {
          emitMomentPurchaseCountToCreator(creatorUser.firebaseUid, {
            momentId: moment._id.toString(),
            purchaseCount: moment.purchaseCount,
          });
        }
      }
    }
    res.json({ success: true, data: dto });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    if (error instanceof PurchaseInProgressError) {
      res.status(409).json({ success: false, error: 'Purchase in progress' });
      return;
    }
    const msg = error instanceof Error ? error.message : 'Purchase failed';
    if (msg.includes('Insufficient')) {
      res.status(400).json({ success: false, error: msg });
      return;
    }
    if (msg.includes('Cannot purchase your own')) {
      res.status(400).json({ success: false, error: msg });
      return;
    }
    logError('Purchase moment failed', error);
    res.status(500).json({ success: false, error: msg });
  }
}

export async function deleteMomentHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const creator = await resolveCreator(user._id);
    const moment = await CreatorMoment.findById(req.params.momentId);
    if (!moment || !creator || !moment.creatorId.equals(creator._id)) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    moment.isDeleted = true;
    await moment.save();
    void removeMomentFromFollowerFeeds(moment._id.toString(), creator._id.toString());
    res.json({ success: true });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    logError('Delete moment failed', error);
    res.status(500).json({ success: false, error: 'Failed to delete moment' });
  }
}

export async function getCreatorMomentsHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    const user = await resolveUser(req);
    const creator = await Creator.findById(req.params.creatorId);
    if (!creator) {
      res.status(404).json({ success: false, error: 'Creator not found' });
      return;
    }
    const moments = await CreatorMoment.find({
      creatorId: creator._id,
      isDeleted: false,
      processingStatus: 'ready',
      moderationStatus: 'approved',
    })
      .sort({ createdAt: -1 })
      .limit(60);
    const followedCreatorIds = await loadFollowedCreatorIds(user?._id ?? null);
    const viewer = { userId: user?._id ?? null, followedCreatorIds };
    const items = (
      await Promise.all(moments.map((m) => toMomentFeedDTO(m, viewer)))
    ).filter(Boolean);
    res.json({ success: true, data: { items } });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    logError('Creator moments failed', error);
    res.status(500).json({ success: false, error: 'Failed to load creator moments' });
  }
}

export async function getCreatorAnalyticsHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const creator = await resolveCreator(user._id);
    if (!creator) {
      res.status(403).json({ success: false, error: 'Creators only' });
      return;
    }
    const [agg] = await MomentRevenue.aggregate([
      { $match: { creatorId: creator._id } },
      {
        $group: {
          _id: null,
          totalEarnings: { $sum: '$creatorShareCoins' },
          purchaseCount: { $sum: 1 },
        },
      },
    ]);
    const [viewsAgg] = await CreatorMoment.aggregate([
      { $match: { creatorId: creator._id } },
      { $group: { _id: null, totalViews: { $sum: '$viewsCount' } } },
    ]);
    const postCount = await CreatorMoment.countDocuments({
      creatorId: creator._id,
      isDeleted: false,
    });
    res.json({
      success: true,
      data: {
        momentsEarnings: agg?.totalEarnings ?? 0,
        purchaseCount: agg?.purchaseCount ?? 0,
        totalViews: viewsAgg?.totalViews ?? 0,
        postCount,
      },
    });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    logError('Creator analytics failed', error);
    res.status(500).json({ success: false, error: 'Failed to load analytics' });
  }
}

export async function followCreatorHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const rate = await checkMomentsRateLimit('follow', user._id.toString());
    if (!rate.allowed) {
      res.status(429).json({ success: false, error: 'Follow rate limit exceeded' });
      return;
    }
    const creatorId = req.params.creatorId;
    if (!mongoose.Types.ObjectId.isValid(creatorId)) {
      res.status(400).json({ success: false, error: 'Invalid creator id' });
      return;
    }
    const creator = await Creator.findById(creatorId);
    if (!creator) {
      res.status(404).json({ success: false, error: 'Creator not found' });
      return;
    }
    if (creator.userId.equals(user._id)) {
      res.status(400).json({ success: false, error: 'Cannot follow yourself' });
      return;
    }
    await CreatorFollow.findOneAndUpdate(
      { followerUserId: user._id, creatorId },
      { $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
    const followerCount = await countCreatorFollowers(creatorId);
    await bustPopularFeedCacheForUser(user._id.toString());
    await bustFollowingWarmCacheForUser(user._id.toString());
    if (user.firebaseUid) {
      emitCreatorFollowed(user.firebaseUid, {
        followerUserId: user._id.toString(),
        creatorId,
        followerCount,
        isFollowing: true,
      });
    }
    const recent = await CreatorMoment.find({
      creatorId,
      ...publicMomentQuery(),
    })
      .sort({ createdAt: -1 })
      .limit(20);
    for (const m of recent) {
      await pushToFollowingFeedCache(user._id.toString(), m._id.toString(), m.feedScore);
    }
    res.json({ success: true, data: { followerCount, isFollowing: true } });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    logError('Follow creator failed', error);
    res.status(500).json({ success: false, error: 'Failed to follow' });
  }
}

export async function unfollowCreatorHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    await CreatorFollow.deleteOne({
      followerUserId: user._id,
      creatorId: req.params.creatorId,
    });
    await removeCreatorFromFollowingFeedCache(user._id.toString(), req.params.creatorId);
    const creatorId = req.params.creatorId;
    const followerCount = await countCreatorFollowers(creatorId);
    await bustPopularFeedCacheForUser(user._id.toString());
    await bustFollowingWarmCacheForUser(user._id.toString());
    if (user.firebaseUid) {
      emitCreatorFollowed(user.firebaseUid, {
        followerUserId: user._id.toString(),
        creatorId,
        followerCount,
        isFollowing: false,
      });
    }
    res.json({ success: true, data: { followerCount, isFollowing: false } });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    logError('Unfollow failed', error);
    res.status(500).json({ success: false, error: 'Failed to unfollow' });
  }
}

export async function getFollowingListHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const follows = await CreatorFollow.find({ followerUserId: user._id }).sort({ createdAt: -1 });
    res.json({
      success: true,
      data: { creatorIds: follows.map((f) => f.creatorId.toString()) },
    });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    logError('Following list failed', error);
    res.status(500).json({ success: false, error: 'Failed to load following' });
  }
}

export async function refreshPlaybackHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    if (!isStreamSigningConfigured()) {
      recordPlaybackRefreshMetric('unavailable');
      res.status(503).json({
        success: false,
        error: 'Playback signing unavailable',
        code: 'PLAYBACK_SIGNING_UNAVAILABLE',
      });
      return;
    }
    const user = await resolveUser(req);
    const moment = await CreatorMoment.findById(req.params.momentId);
    if (!moment) {
      recordPlaybackRefreshMetric('error');
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    const dto = await toMomentPresentationDTO(moment, { userId: user?._id ?? null });
    if (!dto?.media.playbackUrl) {
      recordPlaybackRefreshMetric('denied');
      res.status(403).json({
        success: false,
        error: 'Playback not available',
        code: 'PLAYBACK_DENIED',
      });
      return;
    }
    recordPlaybackRefreshMetric('ok');
    res.json({
      success: true,
      data: {
        playbackUrl: dto.media.playbackUrl,
        expiresAt: getPlaybackTokenExpiresAtMs(),
      },
    });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    recordPlaybackRefreshMetric('error');
    logError('Refresh playback failed', error);
    res.status(500).json({ success: false, error: 'Failed to refresh playback' });
  }
}

export async function completeMomentHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const { watchedPct, completed } = req.body as { watchedPct?: number; completed?: boolean };
    await emitMomentCompleted(user._id.toString(), req.params.momentId, {
      watchedPct,
      completed,
    });
    res.json({ success: true });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    logError('Complete moment failed', error);
    res.status(500).json({ success: false, error: 'Failed to record completion' });
  }
}

export async function getCreatorSummaryHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    const user = await resolveUser(req);
    const creatorId = req.params.creatorId;
    if (!mongoose.Types.ObjectId.isValid(creatorId)) {
      res.status(400).json({ success: false, error: 'Invalid creator id' });
      return;
    }
    const creator = await Creator.findById(creatorId);
    if (!creator) {
      res.status(404).json({ success: false, error: 'Creator not found' });
      return;
    }
    const followerCount = await countCreatorFollowers(creatorId);
    const followingCount = await countCreatorFollowing(creator.userId);
    const postCount = await CreatorMoment.countDocuments({
      creatorId: creator._id,
      isDeleted: false,
      processingStatus: 'ready',
      moderationStatus: 'approved',
    });
    const isFollowing = user
      ? await isUserFollowingCreator(user._id, creatorId)
      : false;
    res.json({
      success: true,
      data: {
        creatorId,
        followerCount,
        followingCount,
        postCount,
        isFollowing,
      },
    });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    logError('Creator summary failed', error);
    res.status(500).json({ success: false, error: 'Failed to load creator summary' });
  }
}

export async function getMyMomentsHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const creator = await resolveCreator(user._id);
    if (!creator) {
      res.status(403).json({ success: false, error: 'Creators only' });
      return;
    }
    const moments = await CreatorMoment.find({
      creatorId: creator._id,
      isDeleted: false,
    }).sort({ createdAt: -1 });
    const items = (
      await Promise.all(
        moments.map((m) => toCreatorSelfMomentDTO(m, { userId: user._id, isCreatorOwner: true })),
      )
    ).filter(Boolean);
    res.json({ success: true, data: { items } });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    logError('My moments failed', error);
    res.status(500).json({ success: false, error: 'Failed to load moments' });
  }
}
