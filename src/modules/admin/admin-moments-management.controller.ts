import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { assertAdmin } from '../../middlewares/staff.middleware';
import { logError, logInfo } from '../../utils/logger';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { CreatorMoment } from '../moments/models/creator-moment.model';
import { FreePreviewMoment } from '../moments/models/free-preview-moment.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { buildMomentImageUrls, buildAvatarUrls } from '../images/image-url';
import {
  debitMomentUploadRewardClawback,
  uploadRewardCreditTransactionId,
} from '../moments/services/moment-upload-reward.service';
import { removePreview } from '../moments/services/free-preview.service';
import { removeMomentFromFollowerFeeds } from '../moments/services/feed-fanout.service';
import { appendAuditEvent, extractAuditContext } from '../audit/audit-event.service';
import { UploadRewardStatus, UPLOAD_REWARD_STATUSES } from '../moments/types/upload-reward-status';
import {
  type MomentVisibilityTier,
} from '../moments/types/moment-visibility-tier';

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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function encodeMomentsGalleryCursor(createdAt: Date, id: mongoose.Types.ObjectId): string {
  return `${createdAt.toISOString()}_${id.toString()}`;
}

export function decodeMomentsGalleryCursor(
  cursor: string,
): { createdAt: Date; id: mongoose.Types.ObjectId } | null {
  const sep = cursor.lastIndexOf('_');
  if (sep <= 0) return null;
  const dateStr = cursor.slice(0, sep);
  const id = cursor.slice(sep + 1);
  const createdAt = new Date(dateStr);
  if (!Number.isFinite(createdAt.getTime()) || !mongoose.Types.ObjectId.isValid(id)) {
    return null;
  }
  return { createdAt, id: new mongoose.Types.ObjectId(id) };
}

export async function listAllMomentsForAdminHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;

    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const cursor = req.query.cursor as string | undefined;
    const q = (req.query.q as string | undefined)?.trim();
    const type = req.query.type as 'photo' | 'video' | undefined;
    const moderationStatus = req.query.moderationStatus as string | undefined;
    const processingStatus = req.query.processingStatus as string | undefined;
    const uploadRewardStatus = req.query.uploadRewardStatus as string | undefined;

    const query: Record<string, unknown> = { isDeleted: false };
    if (type === 'photo' || type === 'video') query.type = type;
    if (moderationStatus) query.moderationStatus = moderationStatus;
    if (processingStatus) query.processingStatus = processingStatus;
    if (
      uploadRewardStatus &&
      UPLOAD_REWARD_STATUSES.includes(uploadRewardStatus as UploadRewardStatus)
    ) {
      query.uploadRewardStatus = uploadRewardStatus;
    }
    if (q) {
      query.caption = { $regex: escapeRegex(q), $options: 'i' };
    }

    const decodedCursor = cursor ? decodeMomentsGalleryCursor(cursor) : null;
    if (cursor && !decodedCursor) {
      res.status(400).json({ success: false, error: 'Invalid cursor' });
      return;
    }

    const pageQuery: Record<string, unknown> = { ...query };
    if (decodedCursor) {
      pageQuery.$or = [
        { createdAt: { $lt: decodedCursor.createdAt } },
        {
          createdAt: decodedCursor.createdAt,
          _id: { $lt: decodedCursor.id },
        },
      ];
    }

    const total = await CreatorMoment.countDocuments(query);

    const moments = await CreatorMoment.find(pageQuery)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean();

    const slice = moments.slice(0, limit);
    const momentIds = slice.map((m) => m._id);

    const [previewRows, rewardTxs] = await Promise.all([
      FreePreviewMoment.find({ momentId: { $in: momentIds } })
        .select('momentId')
        .lean(),
      CoinTransaction.find({
        transactionId: {
          $in: momentIds.map((id) => uploadRewardCreditTransactionId(id.toString())),
        },
      })
        .select('transactionId coins')
        .lean(),
    ]);

    const previewIdSet = new Set(previewRows.map((r) => r.momentId.toString()));
    const rewardMap = new Map<string, number>();
    for (const tx of rewardTxs) {
      const momentId = String(tx.transactionId).replace('moment_upload_reward_', '');
      rewardMap.set(momentId, tx.coins);
    }

    const creatorIds = [...new Set(slice.map((m) => m.creatorId.toString()))];
    const creators = await Creator.find({ _id: { $in: creatorIds } }).lean();
    const creatorMap = new Map(creators.map((c) => [c._id.toString(), c]));

    const items = slice.map((m) => {
      const creator = creatorMap.get(m.creatorId.toString());
      const avatarUrl = creator?.avatar?.imageId
        ? buildAvatarUrls(creator.avatar.imageId).sm
        : undefined;
      const momentId = m._id.toString();
      return {
        momentId,
        caption: m.caption,
        type: m.type,
        viewsCount: m.viewsCount,
        likesCount: m.likesCount,
        commentsCount: m.commentsCount,
        processingStatus: m.processingStatus,
        moderationStatus: m.moderationStatus,
        visibilityTier: (m.visibilityTier ?? 'PUBLIC') as MomentVisibilityTier,
        uploadRewardStatus: m.uploadRewardStatus,
        coinsRewarded: rewardMap.get(momentId) ?? 0,
        createdAt: m.createdAt,
        thumbnailUrl: momentThumbUrl(m),
        inFreePreview: previewIdSet.has(momentId),
        creator: {
          id: m.creatorId.toString(),
          name: creator?.name ?? 'Creator',
          avatarUrl,
          verified: false,
        },
      };
    });

    const last = slice[slice.length - 1];
    const nextCursor =
      moments.length > limit && last
        ? encodeMomentsGalleryCursor(last.createdAt, last._id)
        : undefined;

    res.json({ success: true, data: { items, nextCursor, total } });
  } catch (error) {
    logError('List all moments for admin failed', error);
    res.status(500).json({ success: false, error: 'Failed to list moments' });
  }
}

export async function deleteMomentAsAdminHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;

    const admin = await resolveAdminUser(req);
    if (!admin) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { momentId } = req.params;
    if (!momentId || !mongoose.Types.ObjectId.isValid(momentId)) {
      res.status(400).json({ success: false, error: 'Valid momentId required' });
      return;
    }

    const body = (req.body ?? {}) as { deductCoins?: boolean; reason?: string };
    const deductCoins = body.deductCoins === true;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : undefined;

    const moment = await CreatorMoment.findOne({ _id: momentId, isDeleted: false });
    if (!moment) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }

    const creator = await Creator.findById(moment.creatorId);
    if (!creator?.userId) {
      res.status(404).json({ success: false, error: 'Creator not found' });
      return;
    }

    let coinsClawedBack = 0;
    let creatorNewBalance = 0;

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        if (deductCoins) {
          const clawback = await debitMomentUploadRewardClawback({
            userId: creator.userId,
            creatorId: creator._id,
            momentId,
            actorLabel: admin.email ?? admin._id.toString(),
            session,
          });
          coinsClawedBack = clawback.coinsClawedBack;
          creatorNewBalance = clawback.newBalance;
        } else {
          const user = await User.findById(creator.userId).select('coins').session(session).lean();
          creatorNewBalance = user?.coins ?? 0;
        }

        moment.isDeleted = true;
        await moment.save({ session });
      });
    } finally {
      await session.endSession();
    }

    const inPreview = await FreePreviewMoment.exists({ momentId: moment._id });
    if (inPreview) {
      await removePreview(momentId);
    }

    void removeMomentFromFollowerFeeds(momentId, creator._id.toString());

    const auditCtx = extractAuditContext(req);
    void appendAuditEvent({
      actorUserId: admin._id,
      actorRole: 'super_admin',
      eventType: 'moment_admin_deleted',
      targetType: 'moment',
      targetId: momentId,
      metadata: {
        coinsClawedBack,
        deductCoins,
        reason: reason ?? null,
        creatorId: creator._id.toString(),
      },
      ...auditCtx,
    });

    logInfo('Admin deleted moment', {
      momentId,
      admin: req.auth?.firebaseUid,
      deductCoins,
      coinsClawedBack,
    });

    res.json({
      success: true,
      data: {
        momentId,
        coinsClawedBack,
        deductCoins,
        creatorNewBalance,
      },
    });
  } catch (error) {
    logError('Admin delete moment failed', error);
    res.status(500).json({ success: false, error: 'Failed to delete moment' });
  }
}
