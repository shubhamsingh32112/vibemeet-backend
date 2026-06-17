import mongoose, { Document, Schema } from 'mongoose';

export type MomentsPremiumMembershipStatus = 'active' | 'expired' | 'cancelled';

export interface IMomentsPremiumMembership extends Document {
  userId: mongoose.Types.ObjectId;
  status: MomentsPremiumMembershipStatus;
  planId: string;
  startedAt: Date;
  expiresAt: Date;
  lastPurchaseTxnId?: string;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const momentsPremiumMembershipSchema = new Schema<IMomentsPremiumMembership>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['active', 'expired', 'cancelled'],
      default: 'active',
      index: true,
    },
    planId: {
      type: String,
      required: true,
      index: true,
    },
    startedAt: {
      type: Date,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    lastPurchaseTxnId: {
      type: String,
      sparse: true,
      index: true,
    },
    razorpayOrderId: {
      type: String,
      sparse: true,
      index: true,
    },
    razorpayPaymentId: {
      type: String,
      sparse: true,
      index: true,
    },
  },
  { timestamps: true },
);

export const MomentsPremiumMembership = mongoose.model<IMomentsPremiumMembership>(
  'MomentsPremiumMembership',
  momentsPremiumMembershipSchema,
);
