import mongoose, { Schema, type Document } from 'mongoose';

export type RazorpayCapturedObservationSource =
  | 'wallet_verification'
  | 'wallet_webhook'
  | 'vip_verification'
  | 'vip_webhook'
  | 'moments_verification'
  | 'moments_webhook'
  | 'historical_backfill';

export interface IRazorpayCapturedPayment extends Document {
  paymentId: string;
  providerMode: 'test' | 'live';
  captured: true;
  amountSubunits: number;
  currency: string;
  paymentCreatedAt: Date;
  capturedObservedAt: Date;
  lastObservedAt: Date;
  observationSources: RazorpayCapturedObservationSource[];
}

const schema = new Schema<IRazorpayCapturedPayment>(
  {
    paymentId: { type: String, required: true, unique: true, immutable: true },
    providerMode: { type: String, required: true, enum: ['test', 'live'], immutable: true },
    captured: { type: Boolean, required: true, default: true, immutable: true },
    amountSubunits: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    paymentCreatedAt: { type: Date, required: true },
    capturedObservedAt: { type: Date, required: true },
    lastObservedAt: { type: Date, required: true },
    observationSources: [{ type: String, required: true }],
  },
  { timestamps: true, collection: 'razorpay_captured_payments' }
);

schema.index({ providerMode: 1, currency: 1, paymentCreatedAt: 1 });

export const RazorpayCapturedPayment =
  (mongoose.models.RazorpayCapturedPayment as mongoose.Model<IRazorpayCapturedPayment>) ||
  mongoose.model<IRazorpayCapturedPayment>('RazorpayCapturedPayment', schema);
