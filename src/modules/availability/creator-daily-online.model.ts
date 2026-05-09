import mongoose, { Document, Schema } from 'mongoose';

/** Seconds creator was in Redis "online" (available) during a task day (23:59 boundary). */
export interface ICreatorDailyOnline extends Document {
  _id: mongoose.Types.ObjectId;
  creatorFirebaseUid: string;
  periodStart: Date;
  onlineSeconds: number;
  createdAt: Date;
  updatedAt: Date;
}

const creatorDailyOnlineSchema = new Schema<ICreatorDailyOnline>(
  {
    creatorFirebaseUid: {
      type: String,
      required: true,
      index: true,
    },
    periodStart: {
      type: Date,
      required: true,
    },
    onlineSeconds: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true }
);

creatorDailyOnlineSchema.index(
  { creatorFirebaseUid: 1, periodStart: 1 },
  { unique: true }
);

export const CreatorDailyOnline = mongoose.model<ICreatorDailyOnline>(
  'CreatorDailyOnline',
  creatorDailyOnlineSchema
);
