import mongoose, { Document, Schema } from 'mongoose';

/**
 * Optional overrides for BD/agency revenue splits. Falls back to {@link PlatformRevenueConfig} global singleton.
 */
export interface ICommissionProfile extends Document {
  scope: 'agency' | 'bd';
  subjectId: mongoose.Types.ObjectId;
  bdBps: number;
  agencyBps: number;
  validFrom: Date;
  validTo: Date | null;
  priority: number;
  label?: string;
  createdAt: Date;
}

const commissionProfileSchema = new Schema<ICommissionProfile>(
  {
    scope: { type: String, enum: ['agency', 'bd'], required: true, index: true },
    subjectId: { type: Schema.Types.ObjectId, required: true, index: true },
    bdBps: { type: Number, required: true, min: 0, max: 10000 },
    agencyBps: { type: Number, required: true, min: 0, max: 10000 },
    validFrom: { type: Date, required: true, index: true },
    validTo: { type: Date, default: null, index: true },
    priority: { type: Number, default: 0 },
    label: { type: String, trim: true, maxlength: 120 },
  },
  { timestamps: true }
);

commissionProfileSchema.index({ scope: 1, subjectId: 1, validFrom: -1 });

export const CommissionProfile = mongoose.model<ICommissionProfile>(
  'CommissionProfile',
  commissionProfileSchema
);
