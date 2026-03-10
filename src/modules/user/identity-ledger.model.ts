import mongoose, { Document, Schema } from 'mongoose';

/**
 * Identity Ledger — one welcome bonus per identity.
 * Tracks deviceFingerprint, googleId, and phone to prevent bonus abuse
 * when users delete their account and reinstall the app.
 * Records are never deleted; they persist to prevent bonus farming.
 */
export interface IIdentityLedger extends Document {
  deviceFingerprint?: string;
  googleId?: string;
  phone?: string;
  bonusClaimed: boolean;
  firstUserId: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const identityLedgerSchema = new Schema<IIdentityLedger>(
  {
    deviceFingerprint: {
      type: String,
      sparse: true,
      trim: true,
      maxlength: 256,
    },
    googleId: {
      type: String,
      sparse: true,
      trim: true,
      maxlength: 256,
    },
    phone: {
      type: String,
      sparse: true,
      trim: true,
      maxlength: 64,
    },
    bonusClaimed: {
      type: Boolean,
      required: true,
      default: true,
    },
    firstUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Sparse indexes for fast lookups on each identity type
identityLedgerSchema.index({ deviceFingerprint: 1 }, { sparse: true });
identityLedgerSchema.index({ googleId: 1 }, { sparse: true });
identityLedgerSchema.index({ phone: 1 }, { sparse: true });

// Compound indexes for $or + bonusClaimed queries (speeds up eligibility checks as table grows)
identityLedgerSchema.index({ deviceFingerprint: 1, bonusClaimed: 1 }, { sparse: true });
identityLedgerSchema.index({ googleId: 1, bonusClaimed: 1 }, { sparse: true });
identityLedgerSchema.index({ phone: 1, bonusClaimed: 1 }, { sparse: true });

export const IdentityLedger = mongoose.model<IIdentityLedger>(
  'IdentityLedger',
  identityLedgerSchema
);
