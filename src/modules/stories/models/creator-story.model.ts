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
} from '../../media-shared/types';

export interface ICreatorStory extends Document {
  _id: mongoose.Types.ObjectId;
  creatorId: mongoose.Types.ObjectId;
  type: 'image' | 'video';
  imageAsset?: IImageAsset | null;
  streamVideoId?: string | null;
  durationSeconds?: number | null;
  processingStatus: ProcessingStatus;
  moderationStatus: ContentModerationStatus;
  moderationReason?: string | null;
  moderatedAt?: Date | null;
  visibilityState: VisibilityState;
  mediaVersion: number;
  caption?: string | null;
  thumbnailFallbackUrl?: string | null;
  thumbnailValidated?: boolean;
  createdAt: Date;
  expiresAt: Date;
  viewsCount: number;
  isDeleted: boolean;
}

const creatorStorySchema = new Schema<ICreatorStory>(
  {
    creatorId: { type: Schema.Types.ObjectId, ref: 'Creator', required: true, index: true },
    type: { type: String, enum: ['image', 'video'], required: true },
    imageAsset: { type: imageAssetSchema, default: null },
    streamVideoId: { type: String, default: null, maxlength: 128 },
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
    mediaVersion: { type: Number, default: 1, min: 1 },
    caption: { type: String, default: null, maxlength: 500 },
    thumbnailFallbackUrl: { type: String, default: null },
    thumbnailValidated: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true, index: true },
    viewsCount: { type: Number, default: 0, min: 0 },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: { createdAt: true, updatedAt: true } },
);

creatorStorySchema.index({ creatorId: 1, expiresAt: 1, isDeleted: 1 });
creatorStorySchema.index({ expiresAt: 1, isDeleted: 1 });

export const CreatorStory = mongoose.model<ICreatorStory>('CreatorStory', creatorStorySchema);
