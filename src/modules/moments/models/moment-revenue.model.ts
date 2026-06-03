import mongoose, { Document, Schema } from 'mongoose';

export interface IMomentRevenue extends Document {
  _id: mongoose.Types.ObjectId;
  purchaseId: mongoose.Types.ObjectId;
  momentId: mongoose.Types.ObjectId;
  creatorId: mongoose.Types.ObjectId;
  buyerUserId: mongoose.Types.ObjectId;
  grossCoins: number;
  creatorShareCoins: number;
  platformShareCoins: number;
  createdAt: Date;
}

const momentRevenueSchema = new Schema<IMomentRevenue>(
  {
    purchaseId: { type: Schema.Types.ObjectId, ref: 'MomentPurchase', required: true },
    momentId: { type: Schema.Types.ObjectId, ref: 'CreatorMoment', required: true },
    creatorId: { type: Schema.Types.ObjectId, ref: 'Creator', required: true },
    buyerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    grossCoins: { type: Number, required: true, min: 0 },
    creatorShareCoins: { type: Number, required: true, min: 0 },
    platformShareCoins: { type: Number, required: true, min: 0 },
    createdAt: { type: Date, default: () => new Date() },
  },
  { timestamps: false },
);

momentRevenueSchema.index({ creatorId: 1, createdAt: -1 });

export const MomentRevenue = mongoose.model<IMomentRevenue>(
  'MomentRevenue',
  momentRevenueSchema,
);
