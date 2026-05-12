import mongoose, { Document, Schema } from 'mongoose';

export type FraudSignalSeverity = 'low' | 'medium' | 'high' | 'critical';
export type FraudSignalStatus = 'open' | 'dismissed' | 'escalated';

export interface IFraudSignal extends Document {
  ruleId: string;
  severity: FraudSignalSeverity;
  reason: string;
  metadata: Record<string, unknown>;
  subjectUserId?: mongoose.Types.ObjectId;
  status: FraudSignalStatus;
  triggeredAt: Date;
  resolvedAt?: Date | null;
  idempotencyKey?: string;
  createdAt: Date;
}

const fraudSignalSchema = new Schema<IFraudSignal>(
  {
    ruleId: { type: String, required: true, index: true },
    severity: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium',
      index: true,
    },
    reason: { type: String, required: true, maxlength: 2000 },
    metadata: { type: Schema.Types.Mixed, default: {} },
    subjectUserId: { type: Schema.Types.ObjectId, ref: 'User', sparse: true, index: true },
    status: {
      type: String,
      enum: ['open', 'dismissed', 'escalated'],
      default: 'open',
      index: true,
    },
    triggeredAt: { type: Date, default: () => new Date(), index: true },
    resolvedAt: { type: Date, default: null },
    idempotencyKey: { type: String, trim: true, sparse: true, unique: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

fraudSignalSchema.index({ status: 1, triggeredAt: -1 });

export const FraudSignal = mongoose.model<IFraudSignal>('FraudSignal', fraudSignalSchema);
