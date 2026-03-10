import mongoose, { Document, Schema } from 'mongoose';
import { setAvailability } from '../availability/availability.service';
import { emitCreatorStatus } from '../availability/availability.socket';
import { User } from '../user/user.model';
import { logInfo, logError } from '../../utils/logger';

export interface ICall extends Document {
  _id: mongoose.Types.ObjectId;
  callId: string; // Stream Video call ID (deterministic: userId_creatorId or hashed)
  callerUserId: mongoose.Types.ObjectId; // Reference to User (caller)
  creatorUserId: mongoose.Types.ObjectId; // Reference to User (creator)
  status: 'ringing' | 'accepted' | 'rejected' | 'ended' | 'missed' | 'cancelled';
  
  // Price snapshots (locked at call acceptance time)
  priceAtCallTime?: number; // Creator's price per minute at call start
  creatorShareAtCallTime?: number; // Creator's share percentage (e.g., 0.30 for 30%)
  
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
  },
  {
    timestamps: true,
  }
);

// Compound index for efficient queries: find ended calls between user and creator
callSchema.index({ callerUserId: 1, creatorUserId: 1, status: 1 });

// Compound index for creator earnings queries
callSchema.index({ creatorUserId: 1, status: 1, endedAt: 1 });

// 🔥 FIX: Mark creator busy when call is created or updated to ringing/accepted
// This ensures creator is marked busy even if webhook doesn't fire
callSchema.post('save', async function (doc: ICall) {
  try {
    // Only mark busy if call is in active state (ringing or accepted)
    if (doc.status === 'ringing' || doc.status === 'accepted') {
      const creatorUser = await User.findById(doc.creatorUserId);
      if (creatorUser?.firebaseUid) {
        // Mark creator busy in Redis + Socket.IO
        await setAvailability(creatorUser.firebaseUid, 'busy');
        emitCreatorStatus(creatorUser.firebaseUid, 'busy');
        logInfo('Creator marked busy via Call model post-save hook', {
          callId: doc.callId,
          creatorFirebaseUid: creatorUser.firebaseUid,
          status: doc.status,
        });
      }
    }
  } catch (error) {
    // Non-critical: Don't fail call save if availability update fails
    logError('Failed to mark creator busy in Call post-save hook', error, {
      callId: doc.callId,
    });
  }
});

export const Call = mongoose.model<ICall>('Call', callSchema);
