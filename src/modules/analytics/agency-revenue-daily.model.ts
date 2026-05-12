import mongoose, { Document, Schema } from 'mongoose';

/** Pre-aggregated agency wallet metrics per UTC day (idempotent upserts). */
export interface IAgencyRevenueDaily extends Document {
  dateKey: string;
  agencyId: mongoose.Types.ObjectId;
  totalSettlementCoins: number;
  totalWithdrawalsCoins: number;
  totalCalls: number;
  activeHostsSnapshot?: number;
  createdAt: Date;
  updatedAt: Date;
}

const agencyRevenueDailySchema = new Schema<IAgencyRevenueDaily>(
  {
    dateKey: { type: String, required: true, index: true },
    agencyId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    totalSettlementCoins: { type: Number, default: 0 },
    totalWithdrawalsCoins: { type: Number, default: 0 },
    totalCalls: { type: Number, default: 0 },
    activeHostsSnapshot: { type: Number, min: 0 },
  },
  { timestamps: true }
);

agencyRevenueDailySchema.index({ agencyId: 1, dateKey: 1 }, { unique: true });

export const AgencyRevenueDaily = mongoose.model<IAgencyRevenueDaily>(
  'AgencyRevenueDaily',
  agencyRevenueDailySchema
);
