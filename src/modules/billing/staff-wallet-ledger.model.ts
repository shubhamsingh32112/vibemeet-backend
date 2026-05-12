import mongoose, { Document, Schema } from 'mongoose';

export type StaffWalletLedgerSourceType =
  | 'call_settlement'
  | 'withdrawal_reserve'
  | 'withdrawal_paid'
  | 'withdrawal_reject_refund'
  | 'admin_adjustment'
  | 'referral_transfer';

export interface IStaffWalletLedger extends Document {
  staffUserId: mongoose.Types.ObjectId;
  direction: 'credit' | 'debit';
  amountCoins: number;
  /** Balance after this line (optional but useful for audits). */
  balanceAfter?: number;
  sourceType: StaffWalletLedgerSourceType;
  callId?: string;
  hostUserId?: mongoose.Types.ObjectId;
  creatorMongoId?: mongoose.Types.ObjectId;
  bdUserId?: mongoose.Types.ObjectId;
  agencyUserId?: mongoose.Types.ObjectId;
  bdBpsSnapshot?: number;
  agencyBpsSnapshot?: number;
  withdrawalId?: mongoose.Types.ObjectId;
  description?: string;
  /** Prevent duplicate settlement lines if settlement retries (sparse unique). */
  idempotencyKey?: string;
  createdAt: Date;
}

const staffWalletLedgerSchema = new Schema<IStaffWalletLedger>(
  {
    staffUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    direction: { type: String, enum: ['credit', 'debit'], required: true },
    amountCoins: { type: Number, required: true, min: 0 },
    balanceAfter: { type: Number, min: 0 },
    sourceType: {
      type: String,
      enum: [
        'call_settlement',
        'withdrawal_reserve',
        'withdrawal_paid',
        'withdrawal_reject_refund',
        'admin_adjustment',
        'referral_transfer',
      ],
      required: true,
      index: true,
    },
    callId: { type: String, index: true, sparse: true },
    hostUserId: { type: Schema.Types.ObjectId, ref: 'User', sparse: true },
    creatorMongoId: { type: Schema.Types.ObjectId, ref: 'Creator', sparse: true },
    bdUserId: { type: Schema.Types.ObjectId, ref: 'User', sparse: true },
    agencyUserId: { type: Schema.Types.ObjectId, ref: 'User', sparse: true },
    bdBpsSnapshot: { type: Number, min: 0, max: 10000 },
    agencyBpsSnapshot: { type: Number, min: 0, max: 10000 },
    withdrawalId: { type: Schema.Types.ObjectId, ref: 'Withdrawal', sparse: true },
    description: { type: String, trim: true },
    idempotencyKey: { type: String, trim: true, sparse: true, unique: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

staffWalletLedgerSchema.index({ staffUserId: 1, createdAt: -1 });
staffWalletLedgerSchema.index({ callId: 1, staffUserId: 1 }, { sparse: true });

export const StaffWalletLedger = mongoose.model<IStaffWalletLedger>(
  'StaffWalletLedger',
  staffWalletLedgerSchema
);
