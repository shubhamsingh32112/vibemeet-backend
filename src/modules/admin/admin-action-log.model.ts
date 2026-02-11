import mongoose, { Schema, Document } from 'mongoose';

/**
 * AdminActionLog — Immutable audit trail for every admin mutation.
 * Never edited, never deleted. Append-only.
 */
export interface IAdminActionLog extends Document {
  /** The admin who performed the action */
  adminUserId: mongoose.Types.ObjectId;
  adminEmail: string;

  /** What was done */
  action: string; // e.g. 'COIN_ADJUSTMENT', 'FORCE_OFFLINE', 'CALL_REFUND', 'CREATOR_DELETE'

  /** What entity was affected */
  targetType: 'user' | 'creator' | 'call';
  targetId: string;

  /** Structured metadata about the action */
  details: Record<string, any>;

  /** Human-readable reason (mandatory for mutating actions) */
  reason: string;

  createdAt: Date;
}

const adminActionLogSchema = new Schema<IAdminActionLog>(
  {
    adminUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    adminEmail: { type: String, required: true },
    action: { type: String, required: true, index: true },
    targetType: {
      type: String,
      required: true,
      enum: ['user', 'creator', 'call'],
    },
    targetId: { type: String, required: true, index: true },
    details: { type: Schema.Types.Mixed, default: {} },
    reason: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Compound index for querying all actions on a specific target
adminActionLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

export const AdminActionLog = mongoose.model<IAdminActionLog>(
  'AdminActionLog',
  adminActionLogSchema
);
