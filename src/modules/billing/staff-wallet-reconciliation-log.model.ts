import mongoose, { Document, Schema } from 'mongoose';

/**
 * One row per staff user per reconciliation attempt (or per batch member).
 * Ledger sum is authoritative expectedBalance; User.staffCoinsBalance is the cached projection.
 */
export interface IStaffWalletReconciliationLog extends Document {
  /** Correlates rows from the same reconcile run */
  runId: string;
  staffUserId: mongoose.Types.ObjectId;
  /** Sum(credits) − sum(debits) from StaffWalletLedger */
  expectedBalance: number;
  /** User.staffCoinsBalance at check time */
  actualBalance: number;
  /** actualBalance − expectedBalance (positive ⇒ cache higher than ledger) */
  driftAmount: number;
  autoCorrected: boolean;
  /** Coins delta applied when autoCorrected (expected − actual) */
  correctionAmount: number;
  startedAt: Date;
  completedAt: Date;
  metadata?: Record<string, unknown>;
}

const staffWalletReconciliationLogSchema = new Schema<IStaffWalletReconciliationLog>(
  {
    runId: { type: String, required: true, index: true },
    staffUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    expectedBalance: { type: Number, required: true },
    actualBalance: { type: Number, required: true },
    driftAmount: { type: Number, required: true },
    autoCorrected: { type: Boolean, default: false },
    correctionAmount: { type: Number, default: 0 },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: false }
);

staffWalletReconciliationLogSchema.index({ completedAt: -1 });
staffWalletReconciliationLogSchema.index({ staffUserId: 1, completedAt: -1 });
staffWalletReconciliationLogSchema.index({ runId: 1, staffUserId: 1 });

export const StaffWalletReconciliationLog = mongoose.model<IStaffWalletReconciliationLog>(
  'StaffWalletReconciliationLog',
  staffWalletReconciliationLogSchema
);
