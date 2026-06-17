import mongoose, { Document, Schema } from 'mongoose';

export interface IMomentsPremiumPurchaseEvent extends Document {
  eventId: string;
  eventType: string;
  orderId?: string;
  paymentId?: string;
  userId?: mongoose.Types.ObjectId;
  status: 'received' | 'processing' | 'processed' | 'failed';
  attemptCount: number;
  nextRetryAt?: Date;
  lastAttemptAt?: Date;
  failureReason?: string;
  rawPayload: unknown;
  processedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const momentsPremiumPurchaseEventSchema = new Schema<IMomentsPremiumPurchaseEvent>(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    eventType: {
      type: String,
      required: true,
      index: true,
    },
    orderId: {
      type: String,
      index: true,
    },
    paymentId: {
      type: String,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    status: {
      type: String,
      enum: ['received', 'processing', 'processed', 'failed'],
      default: 'received',
      index: true,
    },
    attemptCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    nextRetryAt: {
      type: Date,
      index: true,
    },
    lastAttemptAt: {
      type: Date,
    },
    failureReason: {
      type: String,
    },
    rawPayload: {
      type: Schema.Types.Mixed,
      required: true,
    },
    processedAt: {
      type: Date,
    },
  },
  { timestamps: true },
);

momentsPremiumPurchaseEventSchema.index({ createdAt: -1 });

export const MomentsPremiumPurchaseEvent = mongoose.model<IMomentsPremiumPurchaseEvent>(
  'MomentsPremiumPurchaseEvent',
  momentsPremiumPurchaseEventSchema,
);
