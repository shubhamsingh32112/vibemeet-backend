import mongoose, { Document, Schema } from 'mongoose';

export interface IUserLoginEvent extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  role: 'user' | 'creator' | 'admin' | 'super_admin' | 'agency' | 'bd';
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

export const UserLoginEvent = mongoose.model<IUserLoginEvent>(
  'UserLoginEvent',
  userLoginEventSchema
);
