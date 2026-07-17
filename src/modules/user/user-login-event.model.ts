import mongoose, { Document, Schema } from 'mongoose';

export interface IUserLoginEvent extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  role: 'user' | 'creator' | 'admin' | 'super_admin' | 'agency' | 'bd';
  /** Client-supplied analytics claim; never use for authorization. */
  clientPlatform: 'web' | 'mobile' | 'unknown';
  accountCreated?: boolean;
  eventKind: 'interactive_login' | 'session_restore' | 'legacy_auth_sync';
  clientEventId?: string;
  loggedInAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userLoginEventSchema = new Schema<IUserLoginEvent>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ['user', 'creator', 'admin', 'super_admin', 'agency', 'bd'],
      required: true,
      index: true,
    },
    clientPlatform: {
      type: String,
      enum: ['web', 'mobile', 'unknown'],
      required: true,
      default: 'unknown',
      index: true,
    },
    accountCreated: {
      type: Boolean,
      sparse: true,
    },
    eventKind: {
      type: String,
      enum: ['interactive_login', 'session_restore', 'legacy_auth_sync'],
      required: true,
      default: 'legacy_auth_sync',
      index: true,
    },
    clientEventId: {
      type: String,
      trim: true,
      maxlength: 128,
    },
    loggedInAt: {
      type: Date,
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

userLoginEventSchema.index({ role: 1, loggedInAt: -1 });
userLoginEventSchema.index({ userId: 1, loggedInAt: -1 });
userLoginEventSchema.index({ clientPlatform: 1, loggedInAt: -1, userId: 1 });
userLoginEventSchema.index({ eventKind: 1, loggedInAt: -1, userId: 1 });
userLoginEventSchema.index({ accountCreated: 1, loggedInAt: -1, userId: 1 });
userLoginEventSchema.index(
  { clientEventId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientEventId: { $type: 'string' } },
  },
);

export const UserLoginEvent = mongoose.model<IUserLoginEvent>(
  'UserLoginEvent',
  userLoginEventSchema
);
