import mongoose, { Document, Schema } from 'mongoose';

/**
 * One row per referred user — unique referredUserId.
 * Mirrors referral edges for analytics, uniqueness, and reward state sync with User.referrals[].
 */
export interface IReferralEdge extends Document {
  _id: mongoose.Types.ObjectId;
  referrerId: mongoose.Types.ObjectId;
  referredUserId: mongoose.Types.ObjectId;
  referralCodeUsed: string;
  rewardGranted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const referralEdgeSchema = new Schema<IReferralEdge>(
  {
    referrerId: {
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
    rewardGranted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true }
);

referralEdgeSchema.index({ referrerId: 1, rewardGranted: 1, createdAt: -1 });

export const ReferralEdge = mongoose.model<IReferralEdge>('ReferralEdge', referralEdgeSchema);
