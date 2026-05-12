/**
 * Canonical embedded image-asset shape used everywhere images are stored
 * (creator avatar, creator gallery item, user avatar, …).
 *
 * Rules:
 *   - Frontend NEVER constructs URLs. Backend serializes to AvatarUrls/GalleryUrls.
 *   - We store rich metadata so future moderation, analytics, dedupe,
 *     and orphan-cleanup can run without re-fetching from Cloudflare.
 *   - moderationStatus: 'pending' | 'auto-ok' | 'approved' | 'rejected'
 *     -> consumers MUST hide assets whose status is 'pending' (when the
 *        IMAGE_MODERATION_PENDING_BY_DEFAULT flag is on) or 'rejected'.
 *
 * Mongoose sub-schema (NO _id) — embed in parent docs:
 *   avatar:       { type: imageAssetSchema, default: null }
 *   galleryImages.asset: imageAssetSchema
 */

import mongoose, { Schema, type Types } from 'mongoose';

export type ImageModerationStatus = 'pending' | 'auto-ok' | 'approved' | 'rejected';

export const IMAGE_MODERATION_STATUSES: readonly ImageModerationStatus[] = [
  'pending',
  'auto-ok',
  'approved',
  'rejected',
] as const;

export interface IImageAsset {
  imageId: string;
  uploadedBy: Types.ObjectId | null;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  mimeType: string | null;
  moderationStatus: ImageModerationStatus;
  createdAt: Date;
}

export const imageAssetSchema = new Schema<IImageAsset>(
  {
    imageId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 128,
    },
    uploadedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    width: { type: Number, default: null, min: 0 },
    height: { type: Number, default: null, min: 0 },
    blurhash: { type: String, default: null, maxlength: 128 },
    mimeType: { type: String, default: null, maxlength: 64 },
    moderationStatus: {
      type: String,
      enum: IMAGE_MODERATION_STATUSES as unknown as string[],
      default: 'auto-ok',
      // NOTE: do NOT add `index: true` here. Parent schemas that embed this
      // sub-schema (`userSchema`, `creatorSchema`) declare their own SPARSE
      // indexes on `avatar.moderationStatus` and
      // `galleryImages.asset.moderationStatus`, which are the indexes that
      // actually serve the admin-moderation queue queries. A bare `index: true`
      // here creates a non-sparse duplicate and Mongoose logs
      // "Duplicate schema index" on every boot.
    },
    createdAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

/** Type guard for incoming payloads. */
export function isImageAsset(value: unknown): value is IImageAsset {
  if (!value || typeof value !== 'object') return false;
  const v = value as IImageAsset;
  return typeof v.imageId === 'string' && v.imageId.length > 0;
}

/** Compact projection for read paths where only the imageId is needed. */
export interface ImageAssetRef {
  imageId: string;
  blurhash: string | null;
  width: number | null;
  height: number | null;
}

export function toImageAssetRef(asset: IImageAsset | null | undefined): ImageAssetRef | null {
  if (!asset || !asset.imageId) return null;
  return {
    imageId: asset.imageId,
    blurhash: asset.blurhash ?? null,
    width: asset.width ?? null,
    height: asset.height ?? null,
  };
}

/** Mongo helper for ad-hoc creation in scripts. */
export function makeImageAssetDoc(input: {
  imageId: string;
  uploadedBy?: Types.ObjectId | null;
  width?: number | null;
  height?: number | null;
  blurhash?: string | null;
  mimeType?: string | null;
  moderationStatus?: ImageModerationStatus;
}): IImageAsset {
  return {
    imageId: input.imageId,
    uploadedBy: input.uploadedBy ?? null,
    width: input.width ?? null,
    height: input.height ?? null,
    blurhash: input.blurhash ?? null,
    mimeType: input.mimeType ?? null,
    moderationStatus: input.moderationStatus ?? 'auto-ok',
    createdAt: new Date(),
  };
}

// Re-export mongoose to satisfy potential ESM bundling in tests.
export { mongoose };
