import mongoose, { Document, Schema } from 'mongoose';
import {
  imageAssetSchema,
  type IImageAsset,
} from '../../images/image-asset.schema';
import {
  CONTENT_MODERATION_STATUSES,
  PROCESSING_STATUSES,
  VISIBILITY_STATES,
  type ContentModerationStatus,
  type ProcessingStatus,
  type VisibilityState,
  type DeletedAccessPolicy,
} from '../../media-shared/types';
import {
  MOMENT_VISIBILITY_TIERS,
  type MomentVisibilityTier,
} from '../types/moment-visibility-tier';

export interface ICreatorMoment extends Document {
  _id: mongoose.Types.ObjectId;
  creatorId: mongoose.Types.ObjectId;
  type: 'photo' | 'video';
  imageAsset?: IImageAsset | null;
  streamVideoId?: string | null;
  thumbnailAsset?: IImageAsset | null;
  durationSeconds?: number | null;
  processingStatus: ProcessingStatus;
  moderationStatus: ContentModerationStatus;
  moderationReason?: string | null;
  moderatedAt?: Date | null;
  visibilityState: VisibilityState;
  /** Content visibility tier for entitlement (PUBLIC = default feed; VIP = VIP-only). */
  visibilityTier: MomentVisibilityTier;
  feedScore: number;
  engagementScore: number;
  mediaVersion: number;
  deletedAccessPolicy: DeletedAccessPolicy;
  caption?: string | null;
  thumbnailFallbackUrl?: string | null;
  thumbnailValidated?: boolean;
  viewsCount: number;
  likesCount: number;
  commentsCount: number;
  /**
   * @deprecated Historical coin-purchase data only. Do not increment in new code.
   * UI should stop displaying this; analytics should use Premium metrics.
   */
  purchaseCount: number;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const creatorMomentSchema = new Schema<ICreatorMoment>(
  {
    creatorId: { type: Schema.Types.ObjectId, ref: 'Creator', required: true, index: true },
    type: { type: String, enum: ['photo', 'video'], required: true },
    imageAsset: { type: imageAssetSchema, default: null },
    streamVideoId: { type: String, default: null, maxlength: 128 },
    thumbnailAsset: { type: imageAssetSchema, default: null },
    durationSeconds: { type: Number, default: null, min: 0 },
    processingStatus: {
      type: String,
      enum: PROCESSING_STATUSES,
      default: 'uploading',
      index: true,
    },
    moderationStatus: {
      type: String,
      enum: CONTENT_MODERATION_STATUSES,
      default: 'approved',
      index: true,
    },
    moderationReason: { type: String, default: null },
    moderatedAt: { type: Date, default: null },
    visibilityState: {
      type: String,
      enum: VISIBILITY_STATES,
      default: 'public',
    },
    visibilityTier: {
      type: String,
      enum: MOMENT_VISIBILITY_TIERS,
      default: 'PUBLIC',
      index: true,
    },
    feedScore: { type: Number, default: () => Date.now(), index: true },
    engagementScore: { type: Number, default: 0, index: true },
    mediaVersion: { type: Number, default: 1, min: 1 },
    deletedAccessPolicy: {
      type: String,
      enum: ['retain_existing', 'fully_remove'],
      default: 'retain_existing',
    },
    caption: { type: String, default: null, maxlength: 2000 },
    thumbnailFallbackUrl: { type: String, default: null },
    thumbnailValidated: { type: Boolean, default: false },
    viewsCount: { type: Number, default: 0, min: 0 },
    likesCount: { type: Number, default: 0, min: 0 },
    commentsCount: { type: Number, default: 0, min: 0 },
    /** @deprecated Historical data only — no new writes */
    purchaseCount: { type: Number, default: 0, min: 0 },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

creatorMomentSchema.index({ creatorId: 1, createdAt: -1 });
creatorMomentSchema.index({ creatorId: 1, isDeleted: 1 });
creatorMomentSchema.index({ feedScore: -1, _id: -1 });

export const CreatorMoment = mongoose.model<ICreatorMoment>(
  'CreatorMoment',
  creatorMomentSchema,
);
