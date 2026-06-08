import mongoose, { Document, Schema } from 'mongoose';

export interface IVipDailyMomentUsage extends Document {
  userId: mongoose.Types.ObjectId;
  usageDate: Date;
  redeemedCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const vipDailyMomentUsageSchema = new Schema<IVipDailyMomentUsage>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    usageDate: {
      type: Date,
      required: true,
      index: true,
    },
    redeemedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true },
);

vipDailyMomentUsageSchema.index({ userId: 1, usageDate: 1 }, { unique: true });

export const VipDailyMomentUsage = mongoose.model<IVipDailyMomentUsage>(
  'VipDailyMomentUsage',
  vipDailyMomentUsageSchema,
);
