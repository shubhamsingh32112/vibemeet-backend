import mongoose, { Document, Schema } from 'mongoose';

export type CheckoutProduct = 'wallet' | 'vip' | 'moments';
export type CheckoutOrigin = 'app' | 'web';
export type CheckoutStatus = 'created' | 'pending' | 'success' | 'failed' | 'cancelled';

export interface ICheckoutContext extends Document {
  checkoutId: string;
  userId: mongoose.Types.ObjectId;
  product: CheckoutProduct;
  origin: CheckoutOrigin;
  returnTo?: string;
  orderId?: string;
  status: CheckoutStatus;
  result?: Record<string, unknown>;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const checkoutContextSchema = new Schema<ICheckoutContext>(
  {
    checkoutId: { type: String, required: true, unique: true, index: true, immutable: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true, immutable: true },
    product: {
      type: String,
      enum: ['wallet', 'vip', 'moments'],
      required: true,
      immutable: true,
    },
    origin: { type: String, enum: ['app', 'web'], required: true, immutable: true },
    returnTo: { type: String, immutable: true },
    orderId: { type: String, sparse: true, index: true },
    status: {
      type: String,
      enum: ['created', 'pending', 'success', 'failed', 'cancelled'],
      default: 'created',
      index: true,
    },
    result: { type: Schema.Types.Mixed },
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: true },
);

checkoutContextSchema.index({ userId: 1, checkoutId: 1 });

export const CheckoutContext = mongoose.model<ICheckoutContext>(
  'CheckoutContext',
  checkoutContextSchema,
);
