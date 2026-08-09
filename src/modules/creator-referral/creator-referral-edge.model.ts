import mongoose, { Document, Schema } from 'mongoose';

/**
 * One row per user referred by a creator (affiliate program).
 * Qualifiers: telegramRewardClaimed + any settled video call (duration > 0).
 */
export interface ICreatorReferralEdge extends Document {
  _id: mongoose.Types.ObjectId;
  creatorUserId: mongoose.Types.ObjectId;
  referredUserId: mongoose.Types.ObjectId;
  referralCodeUsed: string;
  telegramJoinedAt: Date | null;
  videoCallCompletedAt: Date | null;
  creatorRewardedAt: Date | null;
  creatorRewardCoins: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const creatorReferralEdgeSchema = new Schema<ICreatorReferralEdge>(
  {
    creatorUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    referredUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    referralCodeUsed: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 16,
    },
    telegramJoinedAt: {
      type: Date,
      default: null,
    },
    videoCallCompletedAt: {
      type: Date,
      default: null,
    },
    creatorRewardedAt: {
      type: Date,
      default: null,
      index: true,
    },
    creatorRewardCoins: {
      type: Number,
      default: null,
      min: 0,
    },
  },
  { timestamps: true }
);

creatorReferralEdgeSchema.index({ creatorUserId: 1, createdAt: -1 });
creatorReferralEdgeSchema.index({
  creatorUserId: 1,
  creatorRewardedAt: 1,
  telegramJoinedAt: 1,
  videoCallCompletedAt: 1,
});

export const CreatorReferralEdge = mongoose.model<ICreatorReferralEdge>(
  'CreatorReferralEdge',
  creatorReferralEdgeSchema
);
