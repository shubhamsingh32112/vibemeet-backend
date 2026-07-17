import mongoose, { Schema, type Document } from 'mongoose';

export interface IRazorpayProjectionBackfill extends Document {
  mode: 'test' | 'live';
  status: 'pending' | 'running' | 'failed' | 'complete';
  asOf: Date;
  nextSkip: number;
  pagesProcessed: number;
  paymentsObserved: number;
  startedAt: Date;
  completedAt?: Date;
  lastError?: string;
  leaseOwner?: string;
  leaseUntil?: Date;
}

const schema = new Schema<IRazorpayProjectionBackfill>(
  {
    mode: { type: String, required: true, enum: ['test', 'live'], unique: true, immutable: true },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'running', 'failed', 'complete'],
      default: 'pending',
    },
    asOf: { type: Date, required: true },
    nextSkip: { type: Number, required: true, default: 0, min: 0 },
    pagesProcessed: { type: Number, required: true, default: 0, min: 0 },
    paymentsObserved: { type: Number, required: true, default: 0, min: 0 },
    startedAt: { type: Date, required: true },
    completedAt: Date,
    lastError: String,
    leaseOwner: String,
    leaseUntil: Date,
  },
  { timestamps: true, collection: 'razorpay_projection_backfills' }
);

export const RazorpayProjectionBackfill =
  (mongoose.models.RazorpayProjectionBackfill as mongoose.Model<IRazorpayProjectionBackfill>) ||
  mongoose.model<IRazorpayProjectionBackfill>('RazorpayProjectionBackfill', schema);
