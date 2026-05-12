import mongoose, { Document, Schema } from 'mongoose';

export interface IPlatformRevenueDaily extends Document {
  dateKey: string;
  /** Sum of all staff settlement credits (platform-wide staff economics). */
  totalSettlementCoins: number;
  totalWithdrawalsCoins: number;
  totalCalls: number;
  createdAt: Date;
  updatedAt: Date;
}

const platformRevenueDailySchema = new Schema<IPlatformRevenueDaily>(
  {
    dateKey: { type: String, required: true, unique: true, index: true },
    totalSettlementCoins: { type: Number, default: 0 },
    totalWithdrawalsCoins: { type: Number, default: 0 },
    totalCalls: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const PlatformRevenueDaily = mongoose.model<IPlatformRevenueDaily>(
  'PlatformRevenueDaily',
  platformRevenueDailySchema
);
