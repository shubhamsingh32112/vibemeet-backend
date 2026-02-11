import mongoose, { Document, Schema } from 'mongoose';

/**
 * CallHistory — one record PER PARTY PER CALL.
 *
 * When a call settles, two records are created:
 *   1. Owner = user  → "I called <creator>"
 *   2. Owner = creator → "I was called by <user>"
 *
 * The `ownerUserId` is always a User._id (even for creators,
 * because every creator has a backing User doc).
 */
export interface ICallHistory extends Document {
  _id: mongoose.Types.ObjectId;
  callId: string;                    // Stream Video call ID
  ownerUserId: mongoose.Types.ObjectId; // The user who owns this record
  otherUserId: mongoose.Types.ObjectId; // The other party's User._id
  otherName: string;                 // Display name of the other party
  otherAvatar?: string;              // Avatar URL/path of the other party
  otherFirebaseUid: string;          // Firebase UID of the other party (for chat channel creation)
  ownerRole: 'user' | 'creator';    // Role of the owner in this call
  durationSeconds: number;           // Call duration in seconds
  coinsDeducted: number;             // Coins deducted (user) or 0 (creator)
  coinsEarned: number;               // Coins earned (creator) or 0 (user)
  createdAt: Date;
  updatedAt: Date;
}

const callHistorySchema = new Schema<ICallHistory>(
  {
    callId: {
      type: String,
      required: true,
      index: true,
    },
    ownerUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    otherUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    otherName: {
      type: String,
      required: true,
      trim: true,
    },
    otherAvatar: {
      type: String,
      sparse: true,
      trim: true,
    },
    otherFirebaseUid: {
      type: String,
      required: true,
    },
    ownerRole: {
      type: String,
      enum: ['user', 'creator'],
      required: true,
    },
    durationSeconds: {
      type: Number,
      required: true,
      min: 0,
    },
    coinsDeducted: {
      type: Number,
      default: 0,
      min: 0,
    },
    coinsEarned: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for efficient per-user lookups sorted by most recent
callHistorySchema.index({ ownerUserId: 1, createdAt: -1 });

// Prevent duplicate records (one per party per call)
callHistorySchema.index({ callId: 1, ownerUserId: 1 }, { unique: true });

export const CallHistory = mongoose.model<ICallHistory>('CallHistory', callHistorySchema);
