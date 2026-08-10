import mongoose, { Document, Schema } from 'mongoose';

/**
 * One row per user referred by a creator (affiliate program).
 * Stages: signup attach, telegram claim, first purchase (coins|VIP|moments premium).
 */
export interface ICreatorReferralEdge extends Document {
  _id: mongoose.Types.ObjectId;
  creatorUserId: mongoose.Types.ObjectId;
  referredUserId: mongoose.Types.ObjectId;
  referralCodeUsed: string;
  telegramJoinedAt: Date | null;
  /** @deprecated Legacy payout qualifier; not used for new stage payouts. */
  videoCallCompletedAt: Date | null;
  /** @deprecated Legacy single payout; if set, all stages treated as paid. */
  creatorRewardedAt: Date | null;
  /** @deprecated Legacy single payout amount. */
  creatorRewardCoins: number | null;
  attachRewardedAt: Date | null;
  attachRewardCoins: number | null;
  telegramRewardedAt: Date | null;
  telegramRewardCoins: number | null;
  purchaseRewardedAt: Date | null;
  purchaseRewardCoins: number | null;
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
    attachRewardedAt: {
      type: Date,
      default: null,
      index: true,
    },
    attachRewardCoins: {
      type: Number,
      default: null,
      min: 0,
    },
    telegramRewardedAt: {
      type: Date,
      default: null,
      index: true,
    },
    telegramRewardCoins: {
      type: Number,
      default: null,
      min: 0,
    },
    purchaseRewardedAt: {
      type: Date,
      default: null,
      index: true,
    },
    purchaseRewardCoins: {
      type: Number,
      default: null,
      min: 0,
    },
  },
  { timestamps: true }
);

creatorReferralEdgeSchema.index({ creatorUserId: 1, createdAt: -1 });

export const CreatorReferralEdge = mongoose.model<ICreatorReferralEdge>(
  'CreatorReferralEdge',
  creatorReferralEdgeSchema
);
