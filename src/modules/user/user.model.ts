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
  age?: number;
  username?: string;
  avatar?: string; // e.g., 'a1.png' or 'fa1.png'
  categories?: string[]; // Array of category names
  favoriteCreatorIds: mongoose.Types.ObjectId[]; // Users can favorite creators (creator _id values)
  blockedCreatorIds: mongoose.Types.ObjectId[]; // Users can block creators (creator _id values)
  usernameChangeCount: number; // Track how many times username was changed
  coins: number;
  freeTextUsed: number; // Count of free text messages used (first 3 are free)
  welcomeBonusClaimed: boolean; // Whether user has claimed the 30-coin welcome bonus
  onboardingStage?: 'welcome' | 'bonus' | 'permissions' | 'completed';
  onboardingWelcomeSeenAt?: Date | null;
  onboardingBonusSeenAt?: Date | null;
  onboardingPermissionSeenAt?: Date | null;
  onboardingCompletedAt?: Date | null;
  permissionsIntroAcceptedAt?: Date | null;
  cameraMicPermissionStatus?: 'unknown' | 'granted' | 'denied' | 'permanentlyDenied';
  notificationPermissionStatus?: 'unknown' | 'granted' | 'denied' | 'permanentlyDenied';
  permissionsLastCheckedAt?: Date | null;
  lastPermissionsDecisionRequestId?: string | null;
  lastOnboardingStageIdempotencyKey?: string | null;
  permissionOnboardingStatus?: 'accepted' | 'skipped' | 'unknown';
  role: 'user' | 'creator' | 'admin' | 'agent';
  /** Bcrypt hash for agent dashboard login (never store plaintext). */
  passwordHash?: string;
  /** When true, agent JWT login is blocked (super-admin toggle). */
  agentDisabled?: boolean;
  /** Optional label for agent management UI. */
  displayName?: string;
  /** Fast Login: 'google' | 'fast'. Omitted for existing users (treated as Google). */
  authProvider?: 'google' | 'fast';
  /** Fast Login: device fingerprint for lookup (one account per device). */
  deviceFingerprint?: string;
  /** Fast Login: install ID (per app install). */
  installId?: string;
  /** Referral: user's own unique code — legacy 6 chars or current 8 chars. */
  referralCode?: string;
  /** Referral: who referred this user (User._id). */
  referredBy?: mongoose.Types.ObjectId;
  /** Referral: users this user referred, with reward status. */
  referrals?: IReferralEntry[];
  /** Bumped when admin edits profile (creator + linked user); clients show toast when this increases. */
  profileRevision: number;
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
    age: {
      type: Number,
      sparse: true,
      min: 13,
      max: 120,
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
    onboardingStage: {
      type: String,
      enum: ['welcome', 'bonus', 'permissions', 'completed'],
      default: 'welcome',
      index: true,
    },
    onboardingWelcomeSeenAt: {
      type: Date,
      default: null,
    },
    onboardingBonusSeenAt: {
      type: Date,
      default: null,
    },
    onboardingPermissionSeenAt: {
      type: Date,
      default: null,
    },
    onboardingCompletedAt: {
      type: Date,
      default: null,
    },
    permissionsIntroAcceptedAt: {
      type: Date,
      default: null,
    },
    cameraMicPermissionStatus: {
      type: String,
      enum: ['unknown', 'granted', 'denied', 'permanentlyDenied'],
      default: 'unknown',
    },
    notificationPermissionStatus: {
      type: String,
      enum: ['unknown', 'granted', 'denied', 'permanentlyDenied'],
      default: 'unknown',
    },
    permissionsLastCheckedAt: {
      type: Date,
      default: null,
    },
    lastPermissionsDecisionRequestId: {
      type: String,
      default: null,
      trim: true,
      maxlength: 128,
    },
    lastOnboardingStageIdempotencyKey: {
      type: String,
      default: null,
      trim: true,
      maxlength: 160,
    },
    permissionOnboardingStatus: {
      type: String,
      enum: ['accepted', 'skipped', 'unknown'],
      default: 'unknown',
    },
    role: {
      type: String,
      enum: ['user', 'creator', 'admin', 'agent'],
      default: 'user',
    },
    passwordHash: {
      type: String,
      select: false,
      sparse: true,
    },
    agentDisabled: {
      type: Boolean,
      default: false,
    },
    displayName: {
      type: String,
      sparse: true,
      trim: true,
      maxlength: 120,
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
      maxlength: 8,
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
    profileRevision: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Agent / admin: list users referred by a given agent (User._id)
userSchema.index({ referredBy: 1 }, { sparse: true });
// Index for Fast Login lookup (find user by device)
userSchema.index({ deviceFingerprint: 1 }, { sparse: true });
// Unique installId: at most one fast user per install (prevents wrong-user return in installId fallback).
// Sparse so users without installId (e.g. Google sign-in) are not included.
userSchema.index({ installId: 1 }, { unique: true, sparse: true });
// Index for Fast Login migration (find by installId when fingerprint format changed)
userSchema.index({ installId: 1, authProvider: 1 }, { sparse: true });

export const User = mongoose.model<IUser>('User', userSchema);
