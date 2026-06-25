import mongoose, { Document, Schema } from 'mongoose';

export type AnalyticsEventType =
  | 'story_opened'
  | 'story_completed'
  | 'moment_viewed'
  | 'moment_completed'
  | 'moment_purchased'
  | 'moments_paywall_shown'
  | 'creator_followed'
  | 'creator_unfollowed';

export interface IAnalyticsEvent extends Document {
  _id: mongoose.Types.ObjectId;
  type: AnalyticsEventType;
  userId?: mongoose.Types.ObjectId | null;
  targetId?: mongoose.Types.ObjectId | null;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

const analyticsEventSchema = new Schema<IAnalyticsEvent>(
  {
    type: { type: String, required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    targetId: { type: Schema.Types.ObjectId, default: null, index: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: () => new Date(), index: true },
  },
  { timestamps: false },
);

export const AnalyticsEvent = mongoose.model<IAnalyticsEvent>(
  'AnalyticsEvent',
  analyticsEventSchema,
);
