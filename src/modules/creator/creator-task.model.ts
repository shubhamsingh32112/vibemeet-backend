import mongoose, { Document, Schema } from 'mongoose';

export interface ICreatorTaskProgress extends Document {
  _id: mongoose.Types.ObjectId;
  creatorUserId: mongoose.Types.ObjectId; // userId of creator
  taskKey: string; // e.g. "paid_coins_15000"
  /** @deprecated legacy daily minute tasks — kept optional for old docs */
  thresholdMinutes?: number;
  thresholdPaidCoins: number; // 15000, 20000, 30000
  rewardCoins: number;
  periodStart: Date; // Start of the weekly period this record belongs to
  completedAt?: Date; // when threshold reached
  claimedAt?: Date; // when reward claimed
  createdAt: Date;
  updatedAt: Date;
}

const creatorTaskProgressSchema = new Schema<ICreatorTaskProgress>(
  {
    creatorUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    taskKey: {
      type: String,
      required: true,
      trim: true,
    },
    thresholdMinutes: {
      type: Number,
      min: 0,
      sparse: true,
    },
    thresholdPaidCoins: {
      type: Number,
      required: true,
      min: 0,
    },
    rewardCoins: {
      type: Number,
      required: true,
      min: 0,
    },
    periodStart: {
      type: Date,
      required: true,
      index: true,
    },
    completedAt: {
      type: Date,
      sparse: true,
    },
    claimedAt: {
      type: Date,
      sparse: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique index: one task progress per creator per task per period
creatorTaskProgressSchema.index(
  { creatorUserId: 1, taskKey: 1, periodStart: 1 },
  { unique: true },
);

// Index for efficient queries by creator and period
creatorTaskProgressSchema.index({ creatorUserId: 1, periodStart: 1 });

// Index for cleanup of old periods
creatorTaskProgressSchema.index({ periodStart: 1 });

export const CreatorTaskProgress = mongoose.model<ICreatorTaskProgress>(
  'CreatorTaskProgress',
  creatorTaskProgressSchema
);
