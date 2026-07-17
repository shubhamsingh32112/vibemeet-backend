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
  source: 'manual' | 'payment_gateway' | 'recharge_bonus' | 'admin' | 'video_call' | 'chat_message' | 'creator_task' | 'withdrawal' | 'welcome_bonus' | 'referral_reward' | 'moment_purchase' | 'moment_earnings' | 'moment_upload_reward' | 'vip_moment_free' | 'vip_membership' | 'moments_premium_membership'; // Source of the transaction
  description?: string; // Human-readable description
  /** Reason metadata for recharge_bonus (e.g. VIP, Referral, Festival). */
  bonusReason?: string;
  callId?: string; // If transaction is from a video call
  paymentGatewayTransactionId?: string; // External payment gateway transaction ID (if applicable)
  paymentGatewayOrderId?: string; // External payment gateway order ID (if applicable)
  paymentGatewayProvider?: 'razorpay'; // Provider responsible for this transaction
  /** INR charged for payment_gateway recharges (set at checkout). */
  priceInr?: number;
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
      enum: ['manual', 'payment_gateway', 'recharge_bonus', 'admin', 'video_call', 'chat_message', 'creator_task', 'withdrawal', 'welcome_bonus', 'referral_reward', 'moment_purchase', 'moment_earnings', 'moment_upload_reward', 'vip_moment_free', 'vip_membership', 'moments_premium_membership'],
      default: 'manual',
    },
    description: {
      type: String,
      sparse: true,
    },
    bonusReason: {
      type: String,
      sparse: true,
      index: true,
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
    paymentGatewayOrderId: {
      type: String,
      sparse: true,
      index: true,
    },
    paymentGatewayProvider: {
      type: String,
      enum: ['razorpay'],
      sparse: true,
      index: true,
    },
    priceInr: {
      type: Number,
      min: 0,
      sparse: true,
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
// Login balance reconciliation filters by user and completed status, then
// groups by type. Cover that hot path without scanning the user's full ledger.
coinTransactionSchema.index({ userId: 1, status: 1, type: 1 });
coinTransactionSchema.index({ source: 1, paymentGatewayOrderId: 1 });
coinTransactionSchema.index({ source: 1, paymentGatewayTransactionId: 1 });

export const CoinTransaction = mongoose.model<ICoinTransaction>('CoinTransaction', coinTransactionSchema);
