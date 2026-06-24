import mongoose, { Document, Schema } from 'mongoose';
import { CREATOR_GALLERY_MAX_IMAGES } from './creator-gallery.constants';
import { CREATOR_LOCATION_MAX_LEN } from './creator-location.util';
import {
  imageAssetSchema,
  type IImageAsset,
} from '../images/image-asset.schema';

/**
 * Cloudflare-Images shape:
 *   - asset: IImageAsset    — the canonical image reference
 *   - id:    string         — gallery-item ID (stable across asset swaps)
 *   - position / createdAt  — unchanged
 *
 * Legacy Firebase fields (url/storagePath/thumbnailUrl) were removed in
 * Phase E of the Cloudflare migration. New rows MUST carry an `asset`.
 */
export interface ICreatorGalleryImage {
  id: string;
  asset?: IImageAsset | null;
  position: number;
  createdAt: Date;
}

export interface ICreator extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  about: string;
  /** Cloudflare-Images avatar (canonical). */
  avatar?: IImageAsset | null;
  /** Previous avatar — restored if the new one is rejected by moderation. */
  previousAvatar?: IImageAsset | null;
  galleryImages: ICreatorGalleryImage[];
  userId: mongoose.Types.ObjectId;
  firebaseUid?: string;
  categories: string[];
  price: number;
  age?: number;
  location?: string;
  isOnline: boolean;
  isDisabled?: boolean;
  disabledAt?: Date;
  disabledBy?: mongoose.Types.ObjectId;
  currentCallId?: string;
  earningsCoins: number;
  assignedAgencyId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const creatorGalleryImageSchema = new Schema<ICreatorGalleryImage>(
  {
    id: {
      type: String,
      required: true,
      trim: true,
    },
    asset: {
      type: imageAssetSchema,
      default: null,
    },
    position: {
      type: Number,
      required: true,
      min: 0,
    },
    createdAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  { _id: false }
);

const creatorSchema = new Schema<ICreator>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 100,
    },
    about: {
      type: String,
      required: true,
      trim: true,
      minlength: 10,
      maxlength: 1000,
    },
    // ── Cloudflare-Images (canonical) ─────────────────────────────────────
    avatar: {
      type: imageAssetSchema,
      default: null,
    },
    previousAvatar: {
      type: imageAssetSchema,
      default: null,
    },
    galleryImages: {
      type: [creatorGalleryImageSchema],
      default: [],
      validate: {
        validator: (images: ICreatorGalleryImage[]) =>
          Array.isArray(images) && images.length <= CREATOR_GALLERY_MAX_IMAGES,
        message: `galleryImages cannot exceed ${CREATOR_GALLERY_MAX_IMAGES} items`,
      },
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true, // DB-level constraint: No two creators can point to the same user (prevents double promotion)
      index: true,
    },
    firebaseUid: {
      type: String,
      trim: true,
      sparse: true,
      index: true,
    },
    categories: {
      type: [String],
      default: [],
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    age: {
      type: Number,
      sparse: true,
      min: 18,
      max: 100,
    },
    location: {
      type: String,
      trim: true,
      maxlength: CREATOR_LOCATION_MAX_LEN,
      sparse: true,
    },
    isOnline: {
      type: Boolean,
      default: false,
      index: true, // Index for efficient filtering
    },
    isDisabled: {
      type: Boolean,
      default: false,
      index: true,
    },
    disabledAt: {
      type: Date,
      sparse: true,
    },
    disabledBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      sparse: true,
    },
    currentCallId: {
      type: String,
      sparse: true,
      index: true, // Index for efficient lookup of creators in calls
    },
    earningsCoins: {
      type: Number,
      default: 0,
      min: 0,
    },
    assignedAgencyId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      sparse: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

creatorSchema.index({ assignedAgencyId: 1, updatedAt: -1 });
creatorSchema.index({ createdAt: -1 });
creatorSchema.index({ isOnline: 1, createdAt: -1 });
creatorSchema.index({ isDisabled: 1, createdAt: -1 });
// Cloudflare-Images indexes (Phase 2 §2 — orphan-cleanup, moderation lookups, ownership scans).
creatorSchema.index({ 'avatar.imageId': 1 }, { sparse: true });
creatorSchema.index({ 'avatar.moderationStatus': 1 }, { sparse: true });
creatorSchema.index({ 'galleryImages.asset.imageId': 1 }, { sparse: true });
creatorSchema.index({ 'galleryImages.asset.moderationStatus': 1 }, { sparse: true });

/** Creators visible in consumer feed / discovery. */
export const CREATOR_LISTABLE_FILTER = { isDisabled: { $ne: true } } as const;

export const Creator = mongoose.model<ICreator>('Creator', creatorSchema);
