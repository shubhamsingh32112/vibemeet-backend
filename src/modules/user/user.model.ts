import mongoose, { Document, Schema } from 'mongoose';

/** Sub-document for a single referral entry */
export interface IReferralEntry {
  user: mongoose.Types.ObjectId;
  rewardGranted: boolean;
  createdAt: Date;
}

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
  blockedCreatorIds: mongoose.Types.ObjectId[]; // Users can block creators (creator _id values)
  usernameChangeCount: number; // Track how many times username was changed
  coins: number;
  freeTextUsed: number; // Count of free text messages used (first 3 are free)
  welcomeBonusClaimed: boolean; // Whether user has claimed the 30-coin welcome bonus
  role: 'user' | 'creator' | 'admin'; // User role
  /** Fast Login: 'google' | 'fast'. Omitted for existing users (treated as Google). */
  authProvider?: 'google' | 'fast';
  /** Fast Login: device fingerprint for lookup (one account per device). */
  deviceFingerprint?: string;
  /** Fast Login: install ID (per app install). */
  installId?: string;
  /** Referral: user's own unique 6-character code (e.g. JO4832). */
  referralCode?: string;
  /** Referral: who referred this user (User._id). */
  referredBy?: mongoose.Types.ObjectId;
  /** Referral: users this user referred, with reward status. */
  referrals?: IReferralEntry[];
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
    freeTextUsed: {
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
    blockedCreatorIds: {
      type: [Schema.Types.ObjectId],
      ref: 'Creator',
      default: [],
      index: true,
    },
    usernameChangeCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    welcomeBonusClaimed: {
      type: Boolean,
      default: false,
    },
    role: {
      type: String,
      enum: ['user', 'creator', 'admin'],
      default: 'user',
    },
    authProvider: {
      type: String,
      enum: ['google', 'fast'],
      sparse: true,
    },
    deviceFingerprint: {
      type: String,
      sparse: true,
      trim: true,
      maxlength: 256,
    },
    installId: {
      type: String,
      sparse: true,
      trim: true,
      maxlength: 256,
    },
    referralCode: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      uppercase: true,
      index: true,
      maxlength: 6,
    },
    referredBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      sparse: true,
    },
    referrals: [
      {
        user: {
          type: Schema.Types.ObjectId,
          ref: 'User',
          required: true,
        },
        rewardGranted: {
          type: Boolean,
          default: false,
        },
        createdAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  {
    timestamps: true,
  }
);

// Index for Fast Login lookup (find user by device)
userSchema.index({ deviceFingerprint: 1 }, { sparse: true });

export const User = mongoose.model<IUser>('User', userSchema);
