import mongoose, { Document, Schema } from 'mongoose';

export interface IMomentPurchase extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  mediaId: mongoose.Types.ObjectId;
  amountCoins: number;
  purchasedAt: Date;
  transactionId: string;
  ledgerEntryId: mongoose.Types.ObjectId;
  creatorLedgerEntryId?: mongoose.Types.ObjectId | null;
  entitlementVersion: number;
  revenueRecordId: mongoose.Types.ObjectId;
  purchaseSource?: 'coin_purchase' | 'vip_daily_free' | 'vip_discounted';
  refundedAt?: Date | null;
}

const momentPurchaseSchema = new Schema<IMomentPurchase>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    mediaId: { type: Schema.Types.ObjectId, ref: 'CreatorMoment', required: true },
    amountCoins: { type: Number, required: true, min: 0 },
    purchasedAt: { type: Date, default: () => new Date() },
    transactionId: { type: String, required: true, unique: true, index: true },
    ledgerEntryId: { type: Schema.Types.ObjectId, ref: 'CoinTransaction', required: true },
    creatorLedgerEntryId: { type: Schema.Types.ObjectId, ref: 'CoinTransaction', default: null },
    entitlementVersion: { type: Number, required: true, min: 1 },
    revenueRecordId: { type: Schema.Types.ObjectId, ref: 'MomentRevenue', required: true },
    purchaseSource: {
      type: String,
      enum: ['coin_purchase', 'vip_daily_free', 'vip_discounted'],
      default: 'coin_purchase',
    },
    refundedAt: { type: Date, default: null },
  },
  { timestamps: false },
);

momentPurchaseSchema.index({ userId: 1, mediaId: 1 }, { unique: true });

export const MomentPurchase = mongoose.model<IMomentPurchase>(
  'MomentPurchase',
  momentPurchaseSchema,
);
