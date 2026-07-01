import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { assertAdmin } from '../../middlewares/staff.middleware';
import { logError, logInfo } from '../../utils/logger';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { CreatorMoment } from '../moments/models/creator-moment.model';
import { CreatorStory } from '../stories/models/creator-story.model';
import { ESCALATED_MODERATION_STATUSES, type ContentModerationStatus } from '../media-shared/types';
import { buildMomentImageUrls, buildAvatarUrls } from '../images/image-url';
import {
  creditMomentUploadReward,
  resolveMomentUploadRewardCoins,
} from '../moments/services/moment-upload-reward.service';
import { UploadRewardStatus } from '../moments/types/upload-reward-status';

async function resolveAdminUser(req: Request) {
  if (!req.auth?.firebaseUid) return null;
  return User.findOne({ firebaseUid: req.auth.firebaseUid });
}

function momentThumbUrl(moment: {
  type: string;
  imageAsset?: { imageId?: string } | null;
  thumbnailAsset?: { imageId?: string } | null;
  thumbnailFallbackUrl?: string | null;
}): string {
  if (moment.thumbnailFallbackUrl) return moment.thumbnailFallbackUrl;
  if (moment.type === 'photo' && moment.imageAsset?.imageId) {
    return buildMomentImageUrls(moment.imageAsset.imageId).feed;
  }
  if (moment.thumbnailAsset?.imageId) {
    return buildMomentImageUrls(moment.thumbnailAsset.imageId).feed;
  }
  return '';
}

async function setModerationStatus(
  kind: 'moment' | 'story',
  id: string,
  status: ContentModerationStatus,
): Promise<boolean> {
  if (kind === 'moment') {
    const updated = await CreatorMoment.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $set: { moderationStatus: status } },
      { new: true },
    );
    return Boolean(updated);
  }
  const updated = await CreatorStory.findOneAndUpdate(
    { _id: id, isDeleted: false },
    { $set: { moderationStatus: status } },
    { new: true },
  );
  return Boolean(updated);
}

export async function listPendingMomentsModerationHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const [moments, stories] = await Promise.all([
      CreatorMoment.find({ moderationStatus: 'pending', isDeleted: false })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select('_id creatorId type caption createdAt moderationStatus processingStatus')
        .lean(),
      CreatorStory.find({ moderationStatus: 'pending', isDeleted: false })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select('_id creatorId type caption createdAt moderationStatus processingStatus expiresAt')
        .lean(),
    ]);
    res.json({
      success: true,
      data: {
        moments,
        stories,
      },
    });
  } catch (error) {
    logError('List pending moments moderation failed', error);
    res.status(500).json({ success: false, error: 'Failed to list pending content' });
  }
}

export async function approveMomentModerationHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const { kind, id } = req.body as { kind?: 'moment' | 'story'; id?: string };
    if ((kind !== 'moment' && kind !== 'story') || !id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, error: 'kind (moment|story) and valid id required' });
      return;
    }
    const ok = await setModerationStatus(kind, id, 'approved');
    if (!ok) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    logInfo('Moment/story moderation approved', { kind, id, admin: req.auth?.firebaseUid });
    res.json({ success: true, data: { kind, id, moderationStatus: 'approved' } });
  } catch (error) {
    logError('Approve moment moderation failed', error);
    res.status(500).json({ success: false, error: 'Failed to approve content' });
  }
}

export async function listEscalatedMomentsModerationHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const [moments, stories] = await Promise.all([
      CreatorMoment.find({
        moderationStatus: { $in: [...ESCALATED_MODERATION_STATUSES] },
        isDeleted: false,
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select(
          '_id creatorId type caption createdAt moderationStatus moderationReason processingStatus',
        )
        .lean(),
      CreatorStory.find({
        moderationStatus: { $in: [...ESCALATED_MODERATION_STATUSES] },
        isDeleted: false,
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select(
          '_id creatorId type caption createdAt moderationStatus moderationReason processingStatus expiresAt',
        )
        .lean(),
    ]);
    res.json({ success: true, data: { moments, stories } });
  } catch (error) {
    logError('List escalated moments moderation failed', error);
    res.status(500).json({ success: false, error: 'Failed to list escalated content' });
  }
}

export async function escalateMomentModerationHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const { kind, id, status, reason } = req.body as {
      kind?: 'moment' | 'story';
      id?: string;
      status?: ContentModerationStatus;
      reason?: string;
    };
    if ((kind !== 'moment' && kind !== 'story') || !id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, error: 'kind (moment|story) and valid id required' });
      return;
    }
    if (!status || !ESCALATED_MODERATION_STATUSES.includes(status)) {
      res.status(400).json({
        success: false,
        error: `status must be one of: ${ESCALATED_MODERATION_STATUSES.join(', ')}`,
      });
      return;
    }
    if (!reason || reason.trim().length < 3) {
      res.status(400).json({ success: false, error: 'reason is required (min 3 chars)' });
      return;
    }
    const ok = await setModerationStatus(kind, id, status);
    if (!ok) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    const moderationMeta = {
      $set: { moderationReason: reason.trim(), moderatedAt: new Date() },
    };
    if (kind === 'moment') {
      await CreatorMoment.updateOne({ _id: id }, moderationMeta);
    } else {
      await CreatorStory.updateOne({ _id: id }, moderationMeta);
    }
    logInfo('Moment/story moderation escalated', {
      kind,
      id,
      status,
      admin: req.auth?.firebaseUid,
    });
    res.json({ success: true, data: { kind, id, moderationStatus: status } });
  } catch (error) {
    logError('Escalate moment moderation failed', error);
    res.status(500).json({ success: false, error: 'Failed to escalate content' });
  }
}

export async function rejectMomentModerationHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const { kind, id, reason } = req.body as {
      kind?: 'moment' | 'story';
      id?: string;
      reason?: string;
    };
    if ((kind !== 'moment' && kind !== 'story') || !id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, error: 'kind (moment|story) and valid id required' });
      return;
    }
    if (!reason || reason.trim().length < 3) {
      res.status(400).json({ success: false, error: 'reason is required' });
      return;
    }
    const ok = await setModerationStatus(kind, id, 'rejected');
    if (!ok) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    logInfo('Moment/story moderation rejected', {
      kind,
      id,
      reason: reason.trim(),
      admin: req.auth?.firebaseUid,
    });
    res.json({ success: true, data: { kind, id, moderationStatus: 'rejected' } });
  } catch (error) {
    logError('Reject moment moderation failed', error);
    res.status(500).json({ success: false, error: 'Failed to reject content' });
  }
}

export async function getUploadRewardsConfigHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    res.json({
      success: true,
      data: {
        photoRewardCoins: resolveMomentUploadRewardCoins('photo'),
        videoRewardCoins: resolveMomentUploadRewardCoins('video'),
      },
    });
  } catch (error) {
    logError('Get upload rewards config failed', error);
    res.status(500).json({ success: false, error: 'Failed to load upload rewards config' });
  }
}

export async function listPendingUploadRewardsHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const moments = await CreatorMoment.find({
      uploadRewardStatus: UploadRewardStatus.Pending,
      processingStatus: 'ready',
      isDeleted: false,
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select(
        '_id creatorId type caption createdAt processingStatus uploadRewardStatus imageAsset thumbnailAsset thumbnailFallbackUrl',
      )
      .lean();

    const creatorIds = [...new Set(moments.map((m) => m.creatorId.toString()))];
    const creators = await Creator.find({ _id: { $in: creatorIds } })
      .select('_id name userId gallery')
      .lean();
    const creatorById = new Map(creators.map((c) => [c._id.toString(), c]));
    const userIds = creators.map((c) => c.userId).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } }).select('_id displayName avatar').lean();
    const userById = new Map(users.map((u) => [u._id.toString(), u]));

    const items = moments.map((moment) => {
      const creator = creatorById.get(moment.creatorId.toString());
      const user = creator?.userId ? userById.get(creator.userId.toString()) : undefined;
      const avatarUrl = user?.avatar?.imageId
        ? buildAvatarUrls(user.avatar.imageId).sm
        : undefined;
      return {
        id: moment._id.toString(),
        creatorId: moment.creatorId.toString(),
        creatorName: creator?.name ?? user?.displayName ?? 'Creator',
        creatorAvatarUrl: avatarUrl,
        type: moment.type,
        caption: moment.caption,
        createdAt: moment.createdAt,
        thumbnailUrl: momentThumbUrl(moment),
        uploadRewardStatus: moment.uploadRewardStatus,
        rewardCoins: resolveMomentUploadRewardCoins(moment.type),
      };
    });

    res.json({ success: true, data: { items } });
  } catch (error) {
    logError('List pending upload rewards failed', error);
    res.status(500).json({ success: false, error: 'Failed to list pending upload rewards' });
  }
}

export async function approveUploadRewardHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const admin = await resolveAdminUser(req);
    if (!admin) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { id } = req.body as { id?: string };
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, error: 'Valid id required' });
      return;
    }

    const moment = await CreatorMoment.findOne({
      _id: id,
      isDeleted: false,
      processingStatus: 'ready',
    });
    if (!moment) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }

    if (moment.uploadRewardStatus === UploadRewardStatus.Rejected) {
      res.status(409).json({ success: false, error: 'Upload reward was rejected' });
      return;
    }

    const now = new Date();
    const creator = await Creator.findById(moment.creatorId);
    if (!creator?.userId) {
      res.status(404).json({ success: false, error: 'Creator not found' });
      return;
    }

    let coinsCredited = 0;
    let newBalance = 0;
    if (moment.uploadRewardStatus !== UploadRewardStatus.Approved) {
      const reward = await creditMomentUploadReward({
        userId: creator.userId,
        creatorId: creator._id,
        momentId: moment._id.toString(),
        momentType: moment.type,
      });
      coinsCredited = reward?.coinsCredited ?? 0;
      newBalance = reward?.newBalance ?? 0;
    }

    moment.uploadRewardStatus = UploadRewardStatus.Approved;
    moment.uploadRewardApprovedAt = moment.uploadRewardApprovedAt ?? now;
    moment.uploadRewardReviewedBy = admin._id;
    moment.uploadRewardReviewedAt = now;
    await moment.save();

    logInfo('Moment upload reward approved', {
      momentId: id,
      admin: req.auth?.firebaseUid,
      coinsCredited,
    });

    res.json({
      success: true,
      data: {
        id,
        uploadRewardStatus: UploadRewardStatus.Approved,
        coinsCredited,
        newBalance,
        rewardCoins: resolveMomentUploadRewardCoins(moment.type),
      },
    });
  } catch (error) {
    logError('Approve upload reward failed', error);
    res.status(500).json({ success: false, error: 'Failed to approve upload reward' });
  }
}

export async function rejectUploadRewardHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const admin = await resolveAdminUser(req);
    if (!admin) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { id } = req.body as { id?: string };
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, error: 'Valid id required' });
      return;
    }

    const moment = await CreatorMoment.findOneAndUpdate(
      {
        _id: id,
        isDeleted: false,
        uploadRewardStatus: UploadRewardStatus.Pending,
      },
      {
        $set: {
          uploadRewardStatus: UploadRewardStatus.Rejected,
          uploadRewardReviewedBy: admin._id,
          uploadRewardReviewedAt: new Date(),
        },
      },
      { new: true },
    );

    if (!moment) {
      res.status(404).json({ success: false, error: 'Not found or not pending' });
      return;
    }

    logInfo('Moment upload reward rejected', { momentId: id, admin: req.auth?.firebaseUid });
    res.json({
      success: true,
      data: { id, uploadRewardStatus: UploadRewardStatus.Rejected },
    });
  } catch (error) {
    logError('Reject upload reward failed', error);
    res.status(500).json({ success: false, error: 'Failed to reject upload reward' });
  }
}
