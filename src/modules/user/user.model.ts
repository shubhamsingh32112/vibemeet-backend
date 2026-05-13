import mongoose, { Document, Schema } from 'mongoose';
import {
  imageAssetSchema,
  type IImageAsset,
} from '../images/image-asset.schema';

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
  /** Cloudflare-Images avatar (canonical). */
  avatar?: IImageAsset | null;
  /** Restored on moderation rejection. */
  previousAvatar?: IImageAsset | null;
  categories?: string[]; // Array of category names
  favoriteCreatorIds: mongoose.Types.ObjectId[]; // Users can favorite creators (creator _id values)
  blockedCreatorIds: mongoose.Types.ObjectId[]; // Users can block creators (creator _id values)
  usernameChangeCount: number; // Track how many times username was changed
  coins: number;
  /** Promo-only intro call allowance (face-value coin units; billing uses micros). Never IAP/refund wallet. */
  introFreeCallCredits: number;
  /** Set when the welcome intro program is atomically consumed after a qualifying billed session. */
  welcomeFreeCallConsumedAt?: Date | null;
  freeTextUsed: number; // Count of free text messages used (first 3 are free)
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
  role:
    | 'user'
    | 'creator'
    | 'admin'
    | 'agent'
    | 'super_admin'
    | 'agency'
    | 'bd';
  /** Bcrypt hash for agent/bd/agency dashboard login (never store plaintext). */
  passwordHash?: string;
  /** When true, BD/agent JWT login is blocked (super-admin toggle). */
  agentDisabled?: boolean;
  /** When true, agency JWT login is blocked (super-admin toggle). */
  agencyDisabled?: boolean;
  /**
   * Agency / BD portal: user should change password after first login with an auto-generated password.
   * Cleared when they set a new password (or when an admin sets a new password for them).
   */
  staffMustChangePassword?: boolean;
  /** Parent agency User._id for BD (`role === 'bd'` or legacy `agent`). */
  agencyId?: mongoose.Types.ObjectId;
  /** Staff earnings wallet (coins face units); separate from consumer `coins`. */
  staffCoinsBalance?: number;
  /** Host onboarding under BD referral — Flutter reads via creatorApplication* flags. */
  hostOnboardingStatus?:
    | 'none'
    | 'draft'
    | 'pending_bd_approval'
    | 'approved'
    | 'rejected'
    | 'suspended'
    | 'blocked'
    | 'under_review';
  /** Super-admin capability toggles (optional; default allow). */
  staffCapabilities?: {
    editPricing?: boolean;
    managePlatformRevenue?: boolean;
  };
  hostOnboardingRejectedReason?: string;
  bdApprovedAt?: Date | null;
  /** Optional label for agent management UI. */
  displayName?: string;
  /** Agency portal: city/region label (staff-only usage). */
  agencyPlace?: string;
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
    introFreeCallCredits: {
      type: Number,
      default: 0,
      min: 0,
    },
    welcomeFreeCallConsumedAt: {
      type: Date,
      default: null,
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
      type: imageAssetSchema,
      default: null,
    },
    previousAvatar: {
      type: imageAssetSchema,
      default: null,
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
      enum: ['user', 'creator', 'admin', 'agent', 'super_admin', 'agency', 'bd'],
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
    agencyDisabled: {
      type: Boolean,
      default: false,
    },
    staffMustChangePassword: {
      type: Boolean,
      default: false,
    },
    agencyId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      sparse: true,
      index: true,
    },
    staffCoinsBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    hostOnboardingStatus: {
      type: String,
      enum: [
        'none',
        'draft',
        'pending_bd_approval',
        'approved',
        'rejected',
        'suspended',
        'blocked',
        'under_review',
      ],
      default: 'none',
      sparse: true,
    },
    staffCapabilities: {
      editPricing: { type: Boolean, default: true },
      managePlatformRevenue: { type: Boolean, default: true },
    },
    hostOnboardingRejectedReason: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: undefined,
    },
    bdApprovedAt: {
      type: Date,
      default: null,
    },
    displayName: {
      type: String,
      sparse: true,
      trim: true,
      maxlength: 120,
    },
    agencyPlace: {
      type: String,
      sparse: true,
      trim: true,
      maxlength: 200,
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

// Cloudflare-Images indexes for orphan-cleanup + moderation lookups.
userSchema.index({ 'avatar.imageId': 1 }, { sparse: true });
userSchema.index({ 'avatar.moderationStatus': 1 }, { sparse: true });
// Agent / admin: list users referred by a given agent (User._id)
userSchema.index({ referredBy: 1 }, { sparse: true });
// Index for Fast Login lookup (find user by device)
userSchema.index({ deviceFingerprint: 1 }, { sparse: true });
// Unique installId: at most one fast user per install (prevents wrong-user return in installId fallback).
// Sparse so users without installId (e.g. Google sign-in) are not included.
userSchema.index({ installId: 1 }, { unique: true, sparse: true });
// Index for Fast Login migration (find by installId when fingerprint format changed)
userSchema.index({ installId: 1, authProvider: 1 }, { sparse: true });
userSchema.index({ agencyId: 1, role: 1 }, { sparse: true });
userSchema.index({ hostOnboardingStatus: 1, referredBy: 1 }, { sparse: true });

export const User = mongoose.model<IUser>('User', userSchema);
