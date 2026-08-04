import mongoose, { Document, Schema } from 'mongoose';

/**
 * Per-user daily check-in progress.
 * Cycle is sequential (not a consecutive streak): missing days do not reset nextDayIndex.
 */
export interface IDailyCheckInState extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  /** Next reward day in the 1–7 cycle. */
  nextDayIndex: number;
  /** IST YYYY-MM-DD of last successful claim. */
  lastClaimDateKey: string | null;
  /** Day index claimed on lastClaimDateKey. */
  lastClaimedDayIndex: number | null;
  /** IST YYYY-MM-DD when a reminder was last sent (at-most-once per day). */
  lastReminderDateKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const dailyCheckInStateSchema = new Schema<IDailyCheckInState>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    nextDayIndex: {
      type: Number,
      required: true,
      min: 1,
      max: 7,
      default: 1,
    },
    lastClaimDateKey: {
      type: String,
      default: null,
    },
    lastClaimedDayIndex: {
      type: Number,
      min: 1,
      max: 7,
      default: null,
    },
    lastReminderDateKey: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

dailyCheckInStateSchema.index({ lastClaimDateKey: 1, lastReminderDateKey: 1 });

export const DailyCheckInState = mongoose.model<IDailyCheckInState>(
  'DailyCheckInState',
  dailyCheckInStateSchema
);
