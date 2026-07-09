import mongoose, { Schema, Document } from 'mongoose';

/**
 * Withdrawal — Tracks creator and staff (BD/agency) withdrawal requests.
 *
 * Flow:
 *   1. Request → status: 'pending' (no coin deduction)
 *   2. Admin approves → status: 'approved' (balance checked; still no deduction)
 *   3. Admin marks paid → status: 'paid', coins debited, CoinTransaction created
 *   OR
 *   2. Admin rejects → status: 'rejected' (no deduction)
 *
 * Coins are debited only on mark-paid, not on request or approve.
 */
export interface IWithdrawal extends Document {
  _id: mongoose.Types.ObjectId;
  creatorUserId?: mongoose.Types.ObjectId;
  creatorFirebaseUid?: string; // Used by creatorB backend
  amount: number;
  status: 'pending' | 'approved' | 'rejected' | 'paid';
  requestedAt: Date;
  processedAt?: Date;
  adminUserId?: mongoose.Types.ObjectId;
  notes?: string;
  transactionId?: string; // Links to CoinTransaction on mark-paid
  // Withdrawal details
  name?: string;
  number?: string;
  upi?: string;
  accountNumber?: string;
  ifsc?: string;
  /** Copied from Creator.assignedAgencyId at request time for indexed agent queues. */
  assignedAgencyId?: mongoose.Types.ObjectId;
  /** When set, deduction uses `User.staffCoinsBalance` (BD/agency staff wallets). */
  staffUserId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const withdrawalSchema = new Schema<IWithdrawal>(
  {
    creatorUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    creatorFirebaseUid: {
      type: String,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 1,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'paid'],
      default: 'pending',
      index: true,
    },
    requestedAt: {
      type: Date,
      default: Date.now,
    },
    processedAt: {
      type: Date,
    },
    adminUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    notes: {
      type: String,
    },
    transactionId: {
      type: String,
      index: true,
    },
    // Withdrawal details
    name: {
      type: String,
    },
    number: {
      type: String,
    },
    upi: {
      type: String,
    },
    accountNumber: {
      type: String,
    },
    ifsc: {
      type: String,
    },
    assignedAgencyId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      sparse: true,
      index: true,
    },
    staffUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      sparse: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for common queries
withdrawalSchema.index({ assignedAgencyId: 1, status: 1, createdAt: -1 });
withdrawalSchema.index({ assignedAgencyId: 1, createdAt: -1 });
withdrawalSchema.index({ creatorUserId: 1, status: 1 });
withdrawalSchema.index({ status: 1, createdAt: -1 });
withdrawalSchema.index({ createdAt: -1 });
// Index for active-withdrawal lookup by creator
withdrawalSchema.index({ creatorUserId: 1, requestedAt: -1 });
withdrawalSchema.index({ staffUserId: 1, createdAt: -1 }, { sparse: true });

export const Withdrawal = mongoose.model<IWithdrawal>('Withdrawal', withdrawalSchema);
