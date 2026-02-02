import mongoose, { Document, Schema } from 'mongoose';

/**
 * 🔒 IMMUTABLE TRANSACTION MODEL
 * 
 * CRITICAL RULES:
 * - Transactions are APPEND-ONLY (never update or delete)
 * - Only status field may be updated (pending -> completed/failed)
 * - All other fields are immutable after creation
 * - This ensures audit trail integrity for financial records
 * 
 * NAMING CONVENTIONS:
 * - Users: coins, balance, credits, debits
 * - Creators: earnings, totalEarned (NOT coins, NOT balance)
 */
export interface ICoinTransaction extends Document {
  _id: mongoose.Types.ObjectId;
  transactionId: string; // Unique transaction ID for idempotency (from client or payment gateway)
  userId: mongoose.Types.ObjectId; // User involved in transaction
  type: 'credit' | 'debit'; // credit = coins added, debit = coins deducted
  coins: number; // Amount of coins (always positive, type indicates direction)
  source: 'manual' | 'payment_gateway' | 'admin' | 'video_call'; // Source of the transaction
  description?: string; // Human-readable description
  callId?: string; // If transaction is from a video call
  paymentGatewayTransactionId?: string; // External payment gateway transaction ID (if applicable)
  status: 'completed' | 'pending' | 'failed'; // Transaction status
  createdAt: Date;
  updatedAt: Date;
}

const coinTransactionSchema = new Schema<ICoinTransaction>(
  {
    transactionId: {
      type: String,
      required: true,
      unique: true, // Enforce idempotency - same transactionId can only be used once
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['credit', 'debit'],
      required: true,
    },
    coins: {
      type: Number,
      required: true,
      min: 0, // Always positive, type indicates direction
    },
    source: {
      type: String,
      enum: ['manual', 'payment_gateway', 'admin', 'video_call'],
      default: 'manual',
    },
    description: {
      type: String,
      sparse: true,
    },
    callId: {
      type: String,
      sparse: true,
      index: true,
    },
    paymentGatewayTransactionId: {
      type: String,
      sparse: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['completed', 'pending', 'failed'],
      default: 'completed',
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for efficient lookups
coinTransactionSchema.index({ userId: 1, createdAt: -1 });

export const CoinTransaction = mongoose.model<ICoinTransaction>('CoinTransaction', coinTransactionSchema);
