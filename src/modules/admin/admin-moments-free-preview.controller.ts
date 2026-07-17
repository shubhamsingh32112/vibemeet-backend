import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { assertAdmin } from '../../middlewares/staff.middleware';
import { logError } from '../../utils/logger';
import { User } from '../user/user.model';
import { isMomentsEnabled, getMomentsConfig } from '../../config/moments';
import { FreePreviewMoment } from '../moments/models/free-preview-moment.model';
import { CreatorMoment } from '../moments/models/creator-moment.model';
import { Creator } from '../creator/creator.model';
import { buildMomentImageUrls, buildAvatarUrls } from '../images/image-url';
import {
  addPreview,
  listAllPreviewRows,
  removePreview,
  reorderPreviews,
  updatePreviewSchedule,
  invalidatePreviewAndFeedCaches,
  PreviewListVersionConflictError,
} from '../moments/services/free-preview.service';
import {
  isMomentVisibilityTier,
  type MomentVisibilityTier,
} from '../moments/types/moment-visibility-tier';

async function resolveAdminUser(req: Request) {
  if (!req.auth?.firebaseUid) return null;
  return User.findOne({ firebaseUid: req.auth.firebaseUid });
}

function momentThumbUrl(moment: {
  type: string;
  imageAsset?: { imageId?: string } | null;
  thumbnailFallbackUrl?: string | null;
}): string {
  if (moment.thumbnailFallbackUrl) return moment.thumbnailFallbackUrl;
  if (moment.type === 'photo' && moment.imageAsset?.imageId) {
    return buildMomentImageUrls(moment.imageAsset.imageId).feed;
  }
  return '';
}

export async function getMomentsAdminConfigHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const cfg = getMomentsConfig();
    res.json({
      success: true,
      data: {
        momentsEnabled: isMomentsEnabled(),
        freePreviewLimit: cfg.freePreviewLimit,
      },
    });
  } catch (error) {
    logError('Get moments admin config failed', error);
    res.status(500).json({ success: false, error: 'Failed to load config' });
  }
}

export async function listFreePreviewsHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const { items, listVersion } = await listAllPreviewRows();
    res.json({
      success: true,
      data: {
        listVersion,
        items: items.map((p) => ({
          momentId: p.moment._id.toString(),
          order: p.previewRow.order,
          enabled: p.previewRow.enabled,
          startsAt: p.previewRow.startsAt ?? null,
          endsAt: p.previewRow.endsAt ?? null,
          caption: p.moment.caption,
          type: p.moment.type,
          viewsCount: p.moment.viewsCount,
          processingStatus: p.moment.processingStatus,
          moderationStatus: p.moment.moderationStatus,
          visibilityTier: p.moment.visibilityTier ?? 'PUBLIC',
          createdAt: p.moment.createdAt,
          thumbnailUrl: momentThumbUrl(p.moment),
          creator: {
            id: p.creator.id,
            name: p.creator.name,
            avatarUrl: p.creator.avatarUrl,
            verified: p.creator.verified,
          },
        })),
      },
    });
  } catch (error) {
    logError('List free previews failed', error);
    res.status(500).json({ success: false, error: 'Failed to list previews' });
  }
}

export async function reorderFreePreviewsHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const admin = await resolveAdminUser(req);
    if (!admin) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const { orderedMomentIds, expectedVersion } = req.body as {
      orderedMomentIds?: string[];
      expectedVersion?: number;
    };
    if (!Array.isArray(orderedMomentIds) || typeof expectedVersion !== 'number') {
      res.status(400).json({
        success: false,
        error: 'orderedMomentIds and expectedVersion required',
      });
      return;
    }
    const { listVersion } = await reorderPreviews(
      orderedMomentIds,
      expectedVersion,
      admin._id,
    );
    res.json({ success: true, data: { listVersion } });
  } catch (error) {
    if (error instanceof PreviewListVersionConflictError) {
      const { items, listVersion } = await listAllPreviewRows();
      res.status(409).json({
        success: false,
        error: error.message,
        code: error.code,
        currentVersion: listVersion,
        data: { listVersion, items },
      });
      return;
    }
    const msg = error instanceof Error ? error.message : 'Reorder failed';
    res.status(400).json({ success: false, error: msg });
  }
}

export async function addFreePreviewHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const admin = await resolveAdminUser(req);
    if (!admin) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const { momentId, enabled, startsAt, endsAt } = req.body as {
      momentId?: string;
      enabled?: boolean;
      startsAt?: string | null;
      endsAt?: string | null;
    };
    if (!momentId || !mongoose.Types.ObjectId.isValid(momentId)) {
      res.status(400).json({ success: false, error: 'Valid momentId required' });
      return;
    }
    const { listVersion } = await addPreview(momentId, admin._id, {
      enabled,
      startsAt: startsAt ? new Date(startsAt) : null,
      endsAt: endsAt ? new Date(endsAt) : null,
    });
    res.status(201).json({ success: true, data: { listVersion } });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Add preview failed';
    res.status(400).json({ success: false, error: msg });
  }
}

export async function removeFreePreviewHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const { momentId } = req.params;
    const { listVersion } = await removePreview(momentId);
    res.json({ success: true, data: { listVersion } });
  } catch (error) {
    logError('Remove free preview failed', error);
    res.status(500).json({ success: false, error: 'Failed to remove preview' });
  }
}

export async function patchFreePreviewHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const admin = await resolveAdminUser(req);
    if (!admin) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const { momentId } = req.params;
    const { enabled, startsAt, endsAt } = req.body as {
      enabled?: boolean;
      startsAt?: string | null;
      endsAt?: string | null;
    };
    const { listVersion } = await updatePreviewSchedule(momentId, admin._id, {
      enabled,
      startsAt: startsAt === undefined ? undefined : startsAt ? new Date(startsAt) : null,
      endsAt: endsAt === undefined ? undefined : endsAt ? new Date(endsAt) : null,
    });
    res.json({ success: true, data: { listVersion } });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Update failed';
    res.status(400).json({ success: false, error: msg });
  }
}

export async function browseMomentsForAdminHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const cursor = req.query.cursor as string | undefined;
    const q = (req.query.q as string | undefined)?.trim();
    const type = req.query.type as 'photo' | 'video' | undefined;
    const hasPreview = req.query.hasPreview as 'yes' | 'no' | undefined;
    const visibilityTier = req.query.visibilityTier as string | undefined;

    const query: Record<string, unknown> = {
      isDeleted: false,
      processingStatus: 'ready',
      moderationStatus: 'approved',
    };
    if (type === 'photo' || type === 'video') query.type = type;
    if (visibilityTier && isMomentVisibilityTier(visibilityTier)) {
      query.visibilityTier = visibilityTier;
    }
    if (q) {
      query.caption = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    }

    if (hasPreview === 'yes' || hasPreview === 'no') {
      const previewRows = await FreePreviewMoment.find().select('momentId').lean();
      const previewIds = previewRows.map((row) => row.momentId);
      query._id =
        hasPreview === 'yes'
          ? { $in: previewIds }
          : { $nin: previewIds };
    }

    const total = await CreatorMoment.countDocuments(query);

    const pageQuery = { ...query };
    if (cursor) {
      const cursorScore = Number(cursor);
      if (Number.isFinite(cursorScore)) {
        pageQuery.feedScore = { $lt: cursorScore };
      }
    }

    const moments = await CreatorMoment.find(pageQuery)
      .sort({ feedScore: -1, _id: -1 })
      .limit(limit + 1);

    const slice = moments.slice(0, limit);
    const previewRows = await FreePreviewMoment.find({
      momentId: { $in: slice.map((m) => m._id) },
    })
      .select('momentId')
      .lean();
    const previewIdSet = new Set(previewRows.map((r) => r.momentId.toString()));

    const creatorIds = [...new Set(slice.map((m) => m.creatorId.toString()))];
    const creators = await Creator.find({ _id: { $in: creatorIds } }).lean();
    const creatorMap = new Map(creators.map((c) => [c._id.toString(), c]));

    const items = slice.map((m) => {
      const creator = creatorMap.get(m.creatorId.toString());
      const avatarUrl = creator?.avatar?.imageId
        ? buildAvatarUrls(creator.avatar.imageId).sm
        : undefined;
      return {
        momentId: m._id.toString(),
        caption: m.caption,
        type: m.type,
        viewsCount: m.viewsCount,
        processingStatus: m.processingStatus,
        moderationStatus: m.moderationStatus,
        visibilityTier: (m.visibilityTier ?? 'PUBLIC') as MomentVisibilityTier,
        createdAt: m.createdAt,
        thumbnailUrl: momentThumbUrl(m),
        inFreePreview: previewIdSet.has(m._id.toString()),
        creator: {
          id: m.creatorId.toString(),
          name: creator?.name ?? 'Creator',
          avatarUrl,
          verified: false,
        },
      };
    });

    const nextCursor =
      moments.length > limit ? String(slice[slice.length - 1]?.feedScore) : undefined;

    res.json({ success: true, data: { items, nextCursor, total } });
  } catch (error) {
    logError('Browse moments for admin failed', error);
    res.status(500).json({ success: false, error: 'Failed to browse moments' });
  }
}

export async function patchMomentVisibilityTierHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const { momentId } = req.params;
    const { visibilityTier } = req.body as { visibilityTier?: string };
    if (!momentId || !mongoose.Types.ObjectId.isValid(momentId)) {
      res.status(400).json({ success: false, error: 'Valid momentId required' });
      return;
    }
    if (!visibilityTier || !isMomentVisibilityTier(visibilityTier)) {
      res.status(400).json({
        success: false,
        error: `visibilityTier must be one of: PUBLIC, VIP`,
      });
      return;
    }
    const updated = await CreatorMoment.findOneAndUpdate(
      { _id: momentId, isDeleted: false },
      { $set: { visibilityTier } },
      { new: true },
    ).select('_id visibilityTier');
    if (!updated) {
      res.status(404).json({ success: false, error: 'Moment not found' });
      return;
    }
    await invalidatePreviewAndFeedCaches();
    res.json({
      success: true,
      data: {
        momentId: updated._id.toString(),
        visibilityTier: updated.visibilityTier,
      },
    });
  } catch (error) {
    logError('Patch moment visibility tier failed', error);
    res.status(500).json({ success: false, error: 'Failed to update visibility tier' });
  }
}
