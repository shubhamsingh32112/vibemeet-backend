import mongoose, { Document, Schema } from 'mongoose';

export type VipMembershipStatus = 'active' | 'expired' | 'cancelled';

export interface IVipMembership extends Document {
  userId: mongoose.Types.ObjectId;
  status: VipMembershipStatus;
  planId: string;
  startedAt: Date;
  expiresAt: Date;
  lastPurchaseTxnId?: string;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const vipMembershipSchema = new Schema<IVipMembership>(
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

export const VipMembership = mongoose.model<IVipMembership>(
  'VipMembership',
  vipMembershipSchema,
);
