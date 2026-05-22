import mongoose, { Document, Schema } from 'mongoose';

export interface ICall extends Document {
  _id: mongoose.Types.ObjectId;
  callId: string; // Stream Video call ID (deterministic: userId_creatorId or hashed)
  callerUserId: mongoose.Types.ObjectId; // Reference to User (caller)
  creatorUserId: mongoose.Types.ObjectId; // Reference to User (creator)
  status: 'ringing' | 'accepted' | 'rejected' | 'ended' | 'missed' | 'cancelled';
  initiatedByFirebaseUid?: string; // Durable initiator identity (do not infer payer from callId)
  initiatedByRole?: 'user' | 'creator' | 'admin';

  // Price snapshots (aligned with pricingService + billing session)
  priceAtCallTime?: number; // Creator's price per minute at call start
  creatorShareAtCallTime?: number; // Creator's share percentage (e.g., 0.25 for 25%)

  // Call lifecycle timestamps
  startedAt?: Date; // When call session actually started (from Stream webhook)
  acceptedAt?: Date; // When creator accepted the call
  endedAt?: Date; // When call ended
  durationSeconds?: number; // Calculated duration in seconds

  // Billing data
  billedSeconds: number; // Authoritative duration in seconds (per-second billing)
  userCoinsSpent: number; // Total coins spent by user (equals billedSeconds for 1 coin/sec)
  creatorCoinsEarned: number; // Total coins earned by creator (billedSeconds * 0.3)
  userPaidCoins?: number; // Legacy field - coins deducted from user (snapshot)
  isForceEnded: boolean; // True if call ended due to insufficient coins
  isSettled?: boolean; // Whether billing has been processed

  settlement?: {
    status: 'pending' | 'settling' | 'settled' | 'failed';
    source?: string;
    reason?: string;
    settledAt?: Date;
    version?: number;
    updatedAt?: Date;
    ownerToken?: string;
    ownerInstanceId?: string;
  };
  settlementAttempts?: Array<{
    source: string;
    reason: string;
    timestamp: Date;
    result: 'success' | 'duplicate' | 'retry' | 'failed' | 'stale_takeover';
    error?: string;
    ownerToken?: string;
    settlementVersion?: number;
  }>;

  createdAt: Date;
  updatedAt: Date;
}

const callSchema = new Schema<ICall>(
  {
    callId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    callerUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    creatorUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['ringing', 'accepted', 'rejected', 'ended', 'missed', 'cancelled'],
      required: true,
      default: 'ringing',
      index: true,
    },
    initiatedByFirebaseUid: {
      type: String,
      trim: true,
      sparse: true,
      index: true,
    },
    initiatedByRole: {
      type: String,
      enum: ['user', 'creator', 'admin'],
      sparse: true,
      index: true,
    },
    priceAtCallTime: {
      type: Number,
      min: 0,
    },
    creatorShareAtCallTime: {
      type: Number,
      min: 0,
      max: 1,
    },
    startedAt: {
      type: Date,
    },
    acceptedAt: {
      type: Date,
    },
    endedAt: {
      type: Date,
    },
    durationSeconds: {
      type: Number,
      min: 0,
    },
    billedSeconds: {
      type: Number,
      min: 0,
    },
    userCoinsSpent: {
      type: Number,
      min: 0,
    },
    creatorCoinsEarned: {
      type: Number,
      min: 0,
    },
    userPaidCoins: {
      type: Number,
      min: 0,
    },
    isForceEnded: {
      type: Boolean,
      default: false,
    },
    isSettled: {
      type: Boolean,
      default: false,
      index: true,
    },
    settlement: {
      status: {
        type: String,
        enum: ['pending', 'settling', 'settled', 'failed'],
      },
      source: { type: String },
      reason: { type: String },
      settledAt: { type: Date },
      version: { type: Number, default: 0 },
      updatedAt: { type: Date },
      ownerToken: { type: String },
      ownerInstanceId: { type: String },
    },
    settlementAttempts: [
      {
        source: { type: String },
        reason: { type: String },
        timestamp: { type: Date },
        result: {
          type: String,
          enum: ['success', 'duplicate', 'retry', 'failed', 'stale_takeover'],
        },
        error: { type: String },
        ownerToken: { type: String },
        settlementVersion: { type: Number },
      },
    ],
  },
  {
    timestamps: true,
  }
);

// Compound index for efficient queries: find ended calls between user and creator
callSchema.index({ callerUserId: 1, creatorUserId: 1, status: 1 });

// Compound index for creator earnings queries
callSchema.index({ creatorUserId: 1, status: 1, endedAt: 1 });

export const Call = mongoose.model<ICall>('Call', callSchema);
