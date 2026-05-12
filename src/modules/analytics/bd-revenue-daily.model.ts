import mongoose, { Document, Schema } from 'mongoose';

export interface IBdRevenueDaily extends Document {
  dateKey: string;
  bdId: mongoose.Types.ObjectId;
  agencyId?: mongoose.Types.ObjectId | null;
  totalSettlementCoins: number;
  totalCalls: number;
  createdAt: Date;
  updatedAt: Date;
}

const bdRevenueDailySchema = new Schema<IBdRevenueDaily>(
  {
    dateKey: { type: String, required: true, index: true },
    bdId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    agencyId: { type: Schema.Types.ObjectId, ref: 'User', sparse: true, index: true },
    totalSettlementCoins: { type: Number, default: 0 },
    totalCalls: { type: Number, default: 0 },
  },
  { timestamps: true }
);

bdRevenueDailySchema.index({ bdId: 1, dateKey: 1 }, { unique: true });

export const BdRevenueDaily = mongoose.model<IBdRevenueDaily>('BdRevenueDaily', bdRevenueDailySchema);
