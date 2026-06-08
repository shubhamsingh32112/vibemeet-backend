import mongoose, { Document, Schema } from 'mongoose';

export type CallQueueStatus = 'waiting' | 'ringing' | 'expired' | 'cancelled';

export interface ICallQueueEntry extends Document {
  creatorFirebaseUid: string;
  callerFirebaseUid: string;
  callerUserId: mongoose.Types.ObjectId;
  priority: 'vip';
  enqueuedAt: Date;
  expiresAt: Date;
  status: CallQueueStatus;
  callId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const callQueueEntrySchema = new Schema<ICallQueueEntry>(
  {
    creatorFirebaseUid: {
      type: String,
      required: true,
      index: true,
    },
    callerFirebaseUid: {
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
    priority: {
      type: String,
      enum: ['vip'],
      default: 'vip',
    },
    enqueuedAt: {
      type: Date,
      default: () => new Date(),
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['waiting', 'ringing', 'expired', 'cancelled'],
      default: 'waiting',
      index: true,
    },
    callId: {
      type: String,
      sparse: true,
    },
  },
  { timestamps: true },
);

callQueueEntrySchema.index(
  { creatorFirebaseUid: 1, callerFirebaseUid: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'waiting' } },
);

export const CallQueueEntry = mongoose.model<ICallQueueEntry>(
  'CallQueueEntry',
  callQueueEntrySchema,
);
