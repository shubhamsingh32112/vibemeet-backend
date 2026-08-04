import mongoose, { Document, Schema } from 'mongoose';

export type PushPlatform = 'ios' | 'android';

/**
 * First-party FCM device tokens for MatchVibe pushes (daily check-in reminders).
 * Independent of Stream Chat device registration.
 */
export interface IDevicePushToken extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  token: string;
  platform: PushPlatform;
  createdAt: Date;
  updatedAt: Date;
}

const devicePushTokenSchema = new Schema<IDevicePushToken>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    platform: {
      type: String,
      enum: ['ios', 'android'],
      required: true,
    },
  },
  { timestamps: true }
);

devicePushTokenSchema.index({ userId: 1, updatedAt: -1 });

export const DevicePushToken = mongoose.model<IDevicePushToken>(
  'DevicePushToken',
  devicePushTokenSchema
);
