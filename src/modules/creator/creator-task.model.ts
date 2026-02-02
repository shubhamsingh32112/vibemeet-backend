import mongoose, { Document, Schema } from 'mongoose';

export interface ICreatorTaskProgress extends Document {
  _id: mongoose.Types.ObjectId;
  creatorUserId: mongoose.Types.ObjectId; // userId of creator
  taskKey: string; // e.g. "minutes_200"
  thresholdMinutes: number; // 200, 350, 480, etc.
  rewardCoins: number; // 100, 150, 300
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
      required: true,
      min: 0,
    },
    rewardCoins: {
      type: Number,
      required: true,
      min: 0,
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

// Compound unique index: one task progress per creator per task
creatorTaskProgressSchema.index({ creatorUserId: 1, taskKey: 1 }, { unique: true });

// Index for efficient queries by creator and claim status
creatorTaskProgressSchema.index({ creatorUserId: 1, claimedAt: 1 });

export const CreatorTaskProgress = mongoose.model<ICreatorTaskProgress>(
  'CreatorTaskProgress',
  creatorTaskProgressSchema
);
