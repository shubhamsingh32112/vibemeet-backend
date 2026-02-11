import mongoose, { Document, Schema } from 'mongoose';

/**
 * Tracks how many free messages a user has sent to a specific creator.
 *
 * Business rules:
 *   - Each user gets FREE_MESSAGES_PER_CREATOR (3) free messages per creator.
 *   - After the free quota is exhausted, every message costs COST_PER_MESSAGE (5) coins.
 *   - Creators always chat for free.
 */

export const FREE_MESSAGES_PER_CREATOR = 3;
export const COST_PER_MESSAGE = 5;

export interface IChatMessageQuota extends Document {
  _id: mongoose.Types.ObjectId;
  /** Firebase UID of the regular user (sender) */
  userFirebaseUid: string;
  /** Firebase UID of the creator (recipient) */
  creatorFirebaseUid: string;
  /** Deterministic Stream channel ID (for quick lookups) */
  channelId: string;
  /** Number of free messages already sent (0 → FREE_MESSAGES_PER_CREATOR) */
  freeMessagesSent: number;
  /** Total paid messages sent (for analytics) */
  paidMessagesSent: number;
  createdAt: Date;
  updatedAt: Date;
}

const chatMessageQuotaSchema = new Schema<IChatMessageQuota>(
  {
    userFirebaseUid: {
      type: String,
      required: true,
      index: true,
    },
    creatorFirebaseUid: {
      type: String,
      required: true,
      index: true,
    },
    channelId: {
      type: String,
      required: true,
      index: true,
    },
    freeMessagesSent: {
      type: Number,
      default: 0,
      min: 0,
    },
    paidMessagesSent: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Unique per user-creator pair
chatMessageQuotaSchema.index(
  { userFirebaseUid: 1, creatorFirebaseUid: 1 },
  { unique: true }
);

export const ChatMessageQuota = mongoose.model<IChatMessageQuota>(
  'ChatMessageQuota',
  chatMessageQuotaSchema
);
