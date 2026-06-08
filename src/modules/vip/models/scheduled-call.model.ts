import mongoose, { Document, Schema } from 'mongoose';

export type ScheduledCallStatus =
  | 'pending_creator'
  | 'confirmed'
  | 'cancelled'
  | 'completed'
  | 'missed';

export interface IScheduledCall extends Document {
  callerUserId: mongoose.Types.ObjectId;
  creatorId: mongoose.Types.ObjectId;
  creatorFirebaseUid: string;
  scheduledAt: Date;
  durationMinutes: number;
  status: ScheduledCallStatus;
  notes?: string;
  reminderSentAt?: Date | null;
  confirmedAt?: Date | null;
  cancelledAt?: Date | null;
  cancelledBy?: 'caller' | 'creator' | 'system';
  createdAt: Date;
  updatedAt: Date;
}

const scheduledCallSchema = new Schema<IScheduledCall>(
  {
    callerUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    creatorId: {
      type: Schema.Types.ObjectId,
      ref: 'Creator',
      required: true,
      index: true,
    },
    creatorFirebaseUid: {
      type: String,
      required: true,
      index: true,
    },
    scheduledAt: {
      type: Date,
      required: true,
      index: true,
    },
    durationMinutes: {
      type: Number,
      default: 15,
      min: 5,
      max: 120,
    },
    status: {
      type: String,
      enum: ['pending_creator', 'confirmed', 'cancelled', 'completed', 'missed'],
      default: 'pending_creator',
      index: true,
    },
    notes: {
      type: String,
      maxlength: 500,
    },
    reminderSentAt: {
      type: Date,
      default: null,
    },
    confirmedAt: {
      type: Date,
      default: null,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancelledBy: {
      type: String,
      enum: ['caller', 'creator', 'system'],
    },
  },
  { timestamps: true },
);

scheduledCallSchema.index({ callerUserId: 1, scheduledAt: -1 });
scheduledCallSchema.index({ creatorId: 1, status: 1, scheduledAt: 1 });

export const ScheduledCall = mongoose.model<IScheduledCall>(
  'ScheduledCall',
  scheduledCallSchema,
);
