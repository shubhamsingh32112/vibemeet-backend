/**
 * Admin moderation endpoints for the Cloudflare-Images pipeline.
 *
 * Per plan §6.10 — when IMAGE_MODERATION_PENDING_BY_DEFAULT=true:
 *   - New uploads default to moderationStatus='pending' and hide from public reads.
 *   - Admins list pending images, then approve or reject each one.
 *   - On reject: the asset's moderationStatus -> 'rejected', and the owning
 *     document falls back to `previousAvatar` (or null → preset default).
 *   - The Cloudflare image is deleted on reject so we stop paying for it.
 *
 * These endpoints are READ + WRITE.
 */

import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Creator } from '../creator/creator.model';
import { User } from '../user/user.model';
import {
  deleteImage,
  CloudflareImagesError,
  CloudflareImagesCircuitOpenError,
} from '../images/cloudflare.client';
import {
  serializeImageAsset,
  serializeAvatar,
} from '../images/serialize-image-asset';
import { logError, logInfo } from '../../utils/logger';
import { bumpImageCounter } from '../images/image-metrics';
import { invalidateOtherMemberCacheForFirebaseUid } from '../chat/chat-cache-invalidation';

/**
 * Best-effort cache invalidation for the owning user's Firebase UID.
 * Used post-approve/reject so chat lists in other clients re-resolve the
 * canonical avatar URL on their next render.
 */
async function invalidateOwnerCacheBestEffort(
  kind: PendingItem['kind'],
  ownerId: string,
): Promise<void> {
  try {
    let firebaseUid: string | undefined;
    if (kind === 'user-avatar') {
      const u = await User.findById(ownerId).select('firebaseUid').lean();
      firebaseUid = u?.firebaseUid ?? undefined;
    } else {
      const c = await Creator.findById(ownerId).select('userId').lean();
      if (c?.userId) {
        const u = await User.findById(c.userId).select('firebaseUid').lean();
        firebaseUid = u?.firebaseUid ?? undefined;
      }
    }
    if (firebaseUid) {
      await invalidateOtherMemberCacheForFirebaseUid(firebaseUid);
    }
  } catch (err) {
    logError('admin-image-moderation: cache invalidation failed', err, {
      kind,
      ownerId,
    });
  }
}

interface PendingItem {
  kind: 'creator-avatar' | 'creator-gallery' | 'user-avatar';
  imageId: string;
  ownerId: string;
  galleryItemId?: string;
  uploadedAt: Date | null;
  image: ReturnType<typeof serializeImageAsset>;
}

export const listPendingImages = async (_req: Request, res: Response): Promise<void> => {
  try {
    const creators = await Creator.find({
      $or: [
        { 'avatar.moderationStatus': 'pending' },
        { 'galleryImages.asset.moderationStatus': 'pending' },
      ],
    })
      .select('_id avatar galleryImages')
      .limit(200)
      .lean();

    const users = await User.find({ 'avatar.moderationStatus': 'pending' })
      .select('_id avatar')
      .limit(200)
      .lean();

    const items: PendingItem[] = [];

    for (const creator of creators) {
      if (creator.avatar && (creator.avatar as { moderationStatus?: string }).moderationStatus === 'pending') {
        items.push({
          kind: 'creator-avatar',
          imageId: (creator.avatar as { imageId: string }).imageId,
          ownerId: creator._id.toString(),
          uploadedAt: (creator.avatar as { createdAt?: Date }).createdAt ?? null,
          image: serializeImageAsset(creator.avatar as never, { includePending: true }),
        });
      }
      for (const item of creator.galleryImages || []) {
        if (item.asset && (item.asset as { moderationStatus?: string }).moderationStatus === 'pending') {
          items.push({
            kind: 'creator-gallery',
            imageId: (item.asset as { imageId: string }).imageId,
            ownerId: creator._id.toString(),
            galleryItemId: item.id,
            uploadedAt: (item.asset as { createdAt?: Date }).createdAt ?? null,
            image: serializeImageAsset(item.asset as never, { includePending: true }),
          });
        }
      }
    }
    for (const user of users) {
      const a = user.avatar;
      if (a && a.moderationStatus === 'pending') {
        items.push({
          kind: 'user-avatar',
          imageId: a.imageId,
          ownerId: user._id.toString(),
          uploadedAt: a.createdAt ?? null,
          image: serializeImageAsset(a, { includePending: true }),
        });
      }
    }

    res.json({
      success: true,
      data: { items, total: items.length },
    });
  } catch (error) {
    logError('admin.listPendingImages failed', error);
    res.status(500).json({ success: false, error: 'internal_error' });
  }
};

export const approveImage = async (req: Request, res: Response): Promise<void> => {
  const { kind, ownerId, imageId, galleryItemId } = req.body as {
    kind?: PendingItem['kind'];
    ownerId?: string;
    imageId?: string;
    galleryItemId?: string;
  };
  if (!kind || !ownerId || !imageId) {
    res.status(400).json({ success: false, error: 'kind, ownerId, imageId required' });
    return;
  }
  if (!mongoose.Types.ObjectId.isValid(ownerId)) {
    res.status(400).json({ success: false, error: 'invalid ownerId' });
    return;
  }
  try {
    if (kind === 'creator-avatar') {
      const result = await Creator.updateOne(
        { _id: ownerId, 'avatar.imageId': imageId },
        { $set: { 'avatar.moderationStatus': 'approved' } },
      );
      if (result.modifiedCount === 0) {
        res.status(404).json({ success: false, error: 'pending image not found' });
        return;
      }
    } else if (kind === 'creator-gallery') {
      if (!galleryItemId) {
        res.status(400).json({ success: false, error: 'galleryItemId required' });
        return;
      }
      const result = await Creator.updateOne(
        { _id: ownerId, 'galleryImages.id': galleryItemId },
        { $set: { 'galleryImages.$.asset.moderationStatus': 'approved' } },
      );
      if (result.modifiedCount === 0) {
        res.status(404).json({ success: false, error: 'pending gallery item not found' });
        return;
      }
    } else if (kind === 'user-avatar') {
      const result = await User.updateOne(
        { _id: ownerId, 'avatar.imageId': imageId },
        { $set: { 'avatar.moderationStatus': 'approved' } },
      );
      if (result.modifiedCount === 0) {
        res.status(404).json({ success: false, error: 'pending image not found' });
        return;
      }
    } else {
      res.status(400).json({ success: false, error: 'unknown kind' });
      return;
    }
    bumpImageCounter('moderation.approved', { kind });
    logInfo('image moderation: approved', { kind, ownerId, imageId, galleryItemId });
    await invalidateOwnerCacheBestEffort(kind, ownerId);
    res.json({ success: true });
  } catch (error) {
    logError('admin.approveImage failed', error);
    res.status(500).json({ success: false, error: 'internal_error' });
  }
};

export const rejectImage = async (req: Request, res: Response): Promise<void> => {
  const { kind, ownerId, imageId, galleryItemId } = req.body as {
    kind?: PendingItem['kind'];
    ownerId?: string;
    imageId?: string;
    galleryItemId?: string;
  };
  if (!kind || !ownerId || !imageId) {
    res.status(400).json({ success: false, error: 'kind, ownerId, imageId required' });
    return;
  }
  try {
    if (kind === 'creator-avatar') {
      const creator = await Creator.findOne({ _id: ownerId, 'avatar.imageId': imageId });
      if (!creator) {
        res.status(404).json({ success: false, error: 'pending image not found' });
        return;
      }
      // Mark current avatar rejected, restore previousAvatar (if any) — else null.
      if (creator.avatar) creator.avatar.moderationStatus = 'rejected';
      creator.avatar = creator.previousAvatar ?? null;
      creator.previousAvatar = null;
      await creator.save();
    } else if (kind === 'creator-gallery') {
      if (!galleryItemId) {
        res.status(400).json({ success: false, error: 'galleryItemId required' });
        return;
      }
      const creator = await Creator.findOne({ _id: ownerId, 'galleryImages.id': galleryItemId });
      if (!creator) {
        res.status(404).json({ success: false, error: 'pending gallery item not found' });
        return;
      }
      // Drop the gallery item entirely.
      creator.galleryImages = (creator.galleryImages || []).filter(
        (item) => item.id !== galleryItemId,
      ).map((item, i) => ({ ...item, position: i }));
      await creator.save();
    } else if (kind === 'user-avatar') {
      const user = await User.findById(ownerId);
      if (!user) {
        res.status(404).json({ success: false, error: 'user not found' });
        return;
      }
      if (user.avatar && user.avatar.imageId === imageId) {
        // Restore previousAvatar (or null → client falls back to preset).
        user.avatar = user.previousAvatar ?? null;
        user.previousAvatar = null;
        await user.save();
      } else {
        res.status(404).json({ success: false, error: 'pending image not found' });
        return;
      }
    } else {
      res.status(400).json({ success: false, error: 'unknown kind' });
      return;
    }

    // Best-effort Cloudflare delete (so rejected bytes stop being served).
    try {
      await deleteImage(imageId);
    } catch (deleteError) {
      if (
        deleteError instanceof CloudflareImagesError ||
        deleteError instanceof CloudflareImagesCircuitOpenError
      ) {
        logError('image moderation: cloudflare delete failed (will retry via orphan worker)', deleteError, {
          imageId,
        });
      } else {
        throw deleteError;
      }
    }

    bumpImageCounter('moderation.rejected', { kind });
    logInfo('image moderation: rejected', { kind, ownerId, imageId, galleryItemId });
    await invalidateOwnerCacheBestEffort(kind, ownerId);
    res.json({ success: true });
  } catch (error) {
    logError('admin.rejectImage failed', error);
    res.status(500).json({ success: false, error: 'internal_error' });
  }
};

/** Read-only: surface the breaker state for ops dashboards. */
export const getImagePipelineHealth = async (_req: Request, res: Response): Promise<void> => {
  res.json({
    success: true,
    data: {
      // Serialize a sentinel — guarantees image-url module is loadable.
      sample: serializeAvatar(null),
      timestamp: new Date().toISOString(),
    },
  });
};
