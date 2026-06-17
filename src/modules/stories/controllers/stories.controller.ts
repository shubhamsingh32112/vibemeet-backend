import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { User } from '../../user/user.model';
import { Creator } from '../../creator/creator.model';
import {
  assertMomentsEnabled,
  getMomentsConfig,
  respondMomentsDisabled,
} from '../../../config/moments';
import { CreatorStory } from '../models/creator-story.model';
import { StoryView } from '../models/story-view.model';
import { commitImageAsset, CommitImageAssetError } from '../../images/commit-image-asset';
import { consumeStreamUploadSession } from '../../stream/stream-upload-session.service';
import { deleteStreamVideo } from '../../stream/cloudflare-stream.client';
import { deleteImage } from '../../images/cloudflare.client';
import {
  defaultModerationStatus,
  toStoryPresentationDTO,
} from '../../moments/services/moment-presentation.service';
import { markStorySeen, isCreatorUnseen } from '../services/story-seen-cache.service';
import { checkMomentsRateLimit } from '../../moments/services/moments-rate-limit.service';
import { enqueueAnalyticsEvent, emitStoryCompleted } from '../../moments/services/analytics-emitter.service';
import { logError } from '../../../utils/logger';
import { emitStoryUploaded } from '../../moments/moments.gateway';
import { resolveCreatorsMeta } from '../../moments/services/creator-meta.service';
import { buildAvatarUrls } from '../../images/image-url';
import {
  getPlaybackTokenExpiresAtMs,
  isStreamSigningConfigured,
} from '../../stream/signed-token.service';
import { recordPlaybackRefreshMetric } from '../../stream/stream-metrics';

async function resolveUser(req: Request) {
  if (!req.auth?.firebaseUid) return null;
  return User.findOne({ firebaseUid: req.auth.firebaseUid });
}

async function resolveCreator(userId: import('mongoose').Types.ObjectId) {
  return Creator.findOne({ userId });
}

export async function createStoryHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const rate = await checkMomentsRateLimit('upload', user._id.toString());
    if (!rate.allowed) {
      res.status(429).json({ success: false, error: 'Upload rate limit exceeded' });
      return;
    }
    const creator = await resolveCreator(user._id);
    if (!creator) {
      res.status(403).json({ success: false, error: 'Creators only' });
      return;
    }

    const { type, caption, imageSessionId, streamSessionId } = req.body as {
      type: 'image' | 'video';
      caption?: string;
      imageSessionId?: string;
      streamSessionId?: string;
    };

    const cfg = getMomentsConfig();
    const expiresAt = new Date(Date.now() + cfg.storyTtlHours * 60 * 60 * 1000);

    const story = await CreatorStory.create({
      creatorId: creator._id,
      type,
      caption: caption?.trim() || null,
      expiresAt,
      processingStatus: 'uploading',
      moderationStatus: defaultModerationStatus(),
    });

    if (type === 'image' && imageSessionId) {
      const committed = await commitImageAsset({
        sessionId: imageSessionId,
        userId: user._id.toString(),
        userObjectId: user._id,
        purpose: 'story-image',
        quotaScope: 'moments',
        blurhashTarget: { kind: 'story-image', storyId: story._id.toString() },
      });
      story.imageAsset = committed.asset;
      story.processingStatus = 'ready';
      await story.save();
    } else if (type === 'video' && streamSessionId) {
      const session = await consumeStreamUploadSession(
        streamSessionId,
        user._id.toString(),
        'story',
      );
      if (!session) {
        await CreatorStory.deleteOne({ _id: story._id });
        res.status(400).json({ success: false, error: 'Invalid stream session' });
        return;
      }
      story.streamVideoId = session.streamVideoId;
      story.durationSeconds = session.durationSeconds ?? null;
      story.processingStatus = 'ready';
      await story.save();
    } else {
      await CreatorStory.deleteOne({ _id: story._id });
      res.status(400).json({ success: false, error: 'Missing upload session' });
      return;
    }

    const dto = await toStoryPresentationDTO(story, {
      userId: user._id,
      isCreatorOwner: true,
    });
    emitStoryUploaded(creator._id.toString());
    res.status(201).json({ success: true, data: dto });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    if (error instanceof CommitImageAssetError) {
      res.status(error.status).json({ success: false, error: error.message });
      return;
    }
    logError('Create story failed', error);
    res.status(500).json({ success: false, error: 'Failed to create story' });
  }
}

export async function getStoriesFeedHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    const user = await resolveUser(req);
    const now = new Date();
    const stories = await CreatorStory.find({
      isDeleted: false,
      expiresAt: { $gt: now },
      processingStatus: 'ready',
      moderationStatus: 'approved',
    }).sort({ createdAt: -1 });

    const byCreator = new Map<string, typeof stories>();
    for (const s of stories) {
      const key = s.creatorId.toString();
      if (!byCreator.has(key)) byCreator.set(key, []);
      byCreator.get(key)!.push(s);
    }

    const viewerCreator = user ? await resolveCreator(user._id) : null;
    const viewerCreatorId = viewerCreator?._id.toString();

    const groups = [];
    for (const [creatorId, creatorStories] of byCreator) {
      creatorStories.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const latest = creatorStories[creatorStories.length - 1]!;
      const unseen = user
        ? await isCreatorUnseen(user._id.toString(), creatorId, latest.createdAt)
        : true;
      const isOwner = viewerCreatorId === creatorId;
      const items = (
        await Promise.all(
          creatorStories.map((s) =>
            toStoryPresentationDTO(s, {
              userId: user?._id ?? null,
              isCreatorOwner: isOwner,
            }),
          ),
        )
      ).filter(Boolean);
      if (items.length) {
        groups.push({ creatorId, unseen, stories: items });
      }
    }

    groups.sort((a, b) => {
      if (a.unseen !== b.unseen) return a.unseen ? -1 : 1;
      return 0;
    });

    const creatorObjectIds = groups.map(
      (g) => new mongoose.Types.ObjectId(g.creatorId),
    );
    const metaMap = await resolveCreatorsMeta(creatorObjectIds);

    const enrichedGroups = groups.map((g) => {
      const meta = metaMap.get(g.creatorId);
      return {
        ...g,
        creatorName: meta?.name ?? 'Creator',
        creatorAvatarUrl: meta?.avatarUrl,
        creatorFirebaseUid: meta?.firebaseUid,
      };
    });

    res.json({ success: true, data: { groups: enrichedGroups } });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    logError('Stories feed failed', error);
    res.status(500).json({ success: false, error: 'Failed to load stories feed' });
  }
}

export async function getCreatorStoriesHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    const user = await resolveUser(req);
    const now = new Date();
    const stories = await CreatorStory.find({
      creatorId: req.params.creatorId,
      isDeleted: false,
      expiresAt: { $gt: now },
      processingStatus: 'ready',
      moderationStatus: 'approved',
    }).sort({ createdAt: 1 });

    const items = (
      await Promise.all(
        stories.map((s) => toStoryPresentationDTO(s, { userId: user?._id ?? null })),
      )
    ).filter(Boolean);
    res.json({ success: true, data: { stories: items } });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    logError('Creator stories failed', error);
    res.status(500).json({ success: false, error: 'Failed to load stories' });
  }
}

export async function deleteStoryHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const creator = await resolveCreator(user._id);
    const story = await CreatorStory.findById(req.params.storyId);
    if (!story || !creator || !story.creatorId.equals(creator._id)) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    story.isDeleted = true;
    await story.save();
    res.json({ success: true });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    logError('Delete story failed', error);
    res.status(500).json({ success: false, error: 'Failed to delete story' });
  }
}

export async function recordStoryViewHandler(req: Request, res: Response): Promise<void> {
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
    const story = await CreatorStory.findById(req.params.storyId);
    if (!story || story.isDeleted) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }

    const viewerCreator = await resolveCreator(user._id);
    const isOwner = viewerCreator != null && story.creatorId.equals(viewerCreator._id);

    if (!isOwner) {
      const existing = await StoryView.findOne({
        storyId: story._id,
        viewerUserId: user._id,
      });
      if (!existing) {
        await StoryView.create({
          storyId: story._id,
          viewerUserId: user._id,
        });
        story.viewsCount += 1;
        await story.save();
      }
    }

    await markStorySeen(user._id.toString(), story.creatorId.toString(), story.createdAt);
    await enqueueAnalyticsEvent({
      type: 'story_opened',
      userId: user._id.toString(),
      targetId: story._id.toString(),
    });

    res.json({ success: true, data: { viewsCount: story.viewsCount } });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    logError('Record story view failed', error);
    res.status(500).json({ success: false, error: 'Failed to record view' });
  }
}

export async function getStoryViewersHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const creator = await resolveCreator(user._id);
    const story = await CreatorStory.findById(req.params.storyId);
    if (!story || !creator || !story.creatorId.equals(creator._id)) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    const views = await StoryView.find({ storyId: story._id })
      .sort({ viewedAt: -1 })
      .limit(100)
      .populate('viewerUserId', 'username displayName avatar');
    res.json({
      success: true,
      data: {
        viewsCount: story.viewsCount,
        viewers: views.map((v) => {
          const viewer = v.viewerUserId as {
            _id?: mongoose.Types.ObjectId;
            username?: string;
            displayName?: string;
            avatar?: { imageId?: string };
          } | null;
          const userId = viewer?._id?.toString() ?? '';
          const displayName =
            viewer?.displayName?.trim() ||
            viewer?.username?.trim() ||
            'User';
          const avatarUrl = viewer?.avatar?.imageId
            ? buildAvatarUrls(viewer.avatar.imageId).sm
            : undefined;
          return {
            userId,
            displayName,
            avatarUrl,
            viewedAt: v.viewedAt,
          };
        }),
      },
    });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    logError('Story viewers failed', error);
    res.status(500).json({ success: false, error: 'Failed to load viewers' });
  }
}

export async function getMyStoriesHandler(req: Request, res: Response): Promise<void> {
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
    const now = new Date();
    const stories = await CreatorStory.find({
      creatorId: creator._id,
      isDeleted: false,
      expiresAt: { $gt: now },
    }).sort({ createdAt: -1 });

    const items = (
      await Promise.all(
        stories.map((s) =>
          toStoryPresentationDTO(s, { userId: user._id, isCreatorOwner: true }),
        ),
      )
    ).filter(Boolean);
    res.json({ success: true, data: { stories: items } });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    logError('My stories failed', error);
    res.status(500).json({ success: false, error: 'Failed to load stories' });
  }
}

export async function refreshStoryPlaybackHandler(req: Request, res: Response): Promise<void> {
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
    const story = await CreatorStory.findById(req.params.storyId);
    if (!story || story.isDeleted) {
      recordPlaybackRefreshMetric('error');
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    const dto = await toStoryPresentationDTO(story, { userId: user?._id ?? null });
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
    logError('Refresh story playback failed', error);
    res.status(500).json({ success: false, error: 'Failed to refresh playback' });
  }
}

export async function completeStoryHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const { watchedPct, completed } = req.body as { watchedPct?: number; completed?: boolean };
    await emitStoryCompleted(user._id.toString(), req.params.storyId, {
      watchedPct,
      completed,
    });
    res.json({ success: true });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    logError('Complete story failed', error);
    res.status(500).json({ success: false, error: 'Failed to record completion' });
  }
}

export async function expireStoriesJob(): Promise<number> {
  const now = new Date();
  const expired = await CreatorStory.find({
    expiresAt: { $lt: now },
    isDeleted: false,
  });
  for (const story of expired) {
    story.isDeleted = true;
    await story.save();
    if (story.imageAsset?.imageId) {
      await deleteImage(story.imageAsset.imageId).catch(() => undefined);
    }
    if (story.streamVideoId) {
      await deleteStreamVideo(story.streamVideoId);
    }
  }
  return expired.length;
}
