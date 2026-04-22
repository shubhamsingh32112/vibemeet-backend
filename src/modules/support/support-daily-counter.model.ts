import mongoose, { Document, Schema } from 'mongoose';

export interface ISupportDailyCounter extends Document {
  userId: mongoose.Types.ObjectId;
  dayKey: string;
  count: number;
  createdAt: Date;
  updatedAt: Date;
}

const supportDailyCounterSchema = new Schema<ISupportDailyCounter>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    dayKey: {
      type: String,
      required: true,
      index: true,
    },
    count: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true }
);

supportDailyCounterSchema.index({ userId: 1, dayKey: 1 }, { unique: true });

export const SupportDailyCounter = mongoose.model<ISupportDailyCounter>(
  'SupportDailyCounter',
  supportDailyCounterSchema
);
