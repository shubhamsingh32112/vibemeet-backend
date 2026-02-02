import mongoose, { Document, Schema } from 'mongoose';

export type CallStatus = 'initiated' | 'ringing' | 'accepted' | 'rejected' | 'ended' | 'missed';

export interface ICall extends Document {
  _id: mongoose.Types.ObjectId;
  callId: string; // Unique call identifier
  channelName: string; // Agora channel name
  callerUserId: mongoose.Types.ObjectId; // End user who initiated
  creatorUserId: mongoose.Types.ObjectId; // Creator receiving the call
  status: CallStatus;
  token?: string; // Agora token (generated when accepted)
  tokenExpiry?: Date; // Token expiry time
  acceptedAt?: Date; // When call was accepted (video call started)
  endedAt?: Date; // When call ended
  duration?: number; // Call duration in seconds (endedAt - acceptedAt)
  // User rating (per call) – only caller can set, once
  rating?: number; // 1-5 stars
  ratedAt?: Date;
  ratedByCaller?: boolean; // idempotency/guard flag
  // Snapshot fields for earnings calculation (prevent historical data changes)
  priceAtCallTime?: number; // Creator's price per minute at the time of call acceptance (coins/min)
  creatorShareAtCallTime?: number; // Creator's share percentage at the time of call acceptance (e.g., 0.30 for 30%)
  userPaidCoins?: number; // Total coins user paid for this call (calculated at call end)
  isSettled?: boolean; // Flag to prevent double deduction (idempotency)
  maxDurationSeconds?: number; // Max allowed duration in seconds based on caller coins at accept time
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
    channelName: {
      type: String,
      required: true,
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
      enum: ['initiated', 'ringing', 'accepted', 'rejected', 'ended', 'missed'],
      default: 'initiated',
      required: true,
      index: true,
    },
    token: {
      type: String,
      sparse: true,
    },
    tokenExpiry: {
      type: Date,
      sparse: true,
    },
    acceptedAt: {
      type: Date,
      sparse: true,
    },
    endedAt: {
      type: Date,
      sparse: true,
    },
    duration: {
      type: Number,
      sparse: true,
      min: 0,
    },
    // User rating (per call) – only caller can set, once
    rating: {
      type: Number,
      sparse: true,
      min: 1,
      max: 5,
      index: true,
    },
    ratedAt: {
      type: Date,
      sparse: true,
    },
    ratedByCaller: {
      type: Boolean,
      default: false,
      index: true,
    },
    // Snapshot fields for earnings calculation (prevent historical data changes)
    priceAtCallTime: {
      type: Number,
      sparse: true,
      min: 0,
    },
    creatorShareAtCallTime: {
      type: Number,
      sparse: true,
      min: 0,
      max: 1,
    },
    userPaidCoins: {
      type: Number,
      sparse: true,
      min: 0,
    },
    isSettled: {
      type: Boolean,
      default: false,
      index: true, // Index for idempotency checks
    },
    maxDurationSeconds: {
      type: Number,
      sparse: true,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Performance indexes for efficient queries
callSchema.index({ creatorUserId: 1, status: 1 }); // Active calls for creator
callSchema.index({ callerUserId: 1, status: 1 }); // Active calls for caller
callSchema.index({ creatorUserId: 1, createdAt: -1 }); // Creator transaction history (earnings)
callSchema.index({ creatorUserId: 1, endedAt: -1 }); // Creator earnings sorted by end time
callSchema.index({ isSettled: 1 }); // Idempotency checks
callSchema.index({ creatorUserId: 1, rating: 1, endedAt: -1 }); // Rating analytics per creator

export const Call = mongoose.model<ICall>('Call', callSchema);
