import mongoose, { Document, Schema } from 'mongoose';

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  firebaseUid: string;
  email?: string;
  phone?: string;
  gender?: 'male' | 'female' | 'other';
  username?: string;
  avatar?: string; // e.g., 'a1.png' or 'fa1.png'
  categories?: string[]; // Array of category names
  favoriteCreatorIds: mongoose.Types.ObjectId[]; // Users can favorite creators (creator _id values)
  usernameChangeCount: number; // Track how many times username was changed (max 3)
  coins: number;
  role: 'user' | 'creator' | 'admin'; // User role
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    firebaseUid: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    email: {
      type: String,
      sparse: true,
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      sparse: true,
      trim: true,
    },
    coins: {
      type: Number,
      default: 0,
      min: 0,
    },
    gender: {
      type: String,
      enum: ['male', 'female', 'other'],
      sparse: true,
    },
    username: {
      type: String,
      sparse: true,
      trim: true,
      minlength: 4,
      maxlength: 10,
    },
    avatar: {
      type: String,
      sparse: true,
      trim: true,
    },
    categories: {
      type: [String],
      default: [],
    },
    favoriteCreatorIds: {
      type: [Schema.Types.ObjectId],
      ref: 'Creator',
      default: [],
      index: true,
    },
    usernameChangeCount: {
      type: Number,
      default: 0,
      min: 0,
      max: 3,
    },
    role: {
      type: String,
      enum: ['user', 'creator', 'admin'],
      default: 'user',
    },
  },
  {
    timestamps: true,
  }
);

export const User = mongoose.model<IUser>('User', userSchema);
