import mongoose from 'mongoose';
import { User } from '../user/user.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { MomentsPremiumMembership } from './models/moments-premium-membership.model';
import { getMomentsPremiumPlanById } from './models/moments-premium-plan-config.model';
import { invalidateMomentsPremiumCache } from './moments-premium-entitlement.service';

export interface FinalizeMomentsPremiumPurchaseInput {
  userId: string;
  orderId: string;
  paymentId: string;
  priceInr: number;
  planId: string;
  durationDays?: number;
}

export interface FinalizeMomentsPremiumPurchaseResult {
  alreadyProcessed: boolean;
  expiresAt: Date;
  membershipId: string;
}

const buildTxnId = (orderId: string): string => `moments_premium_${orderId}`;

export async function finalizeMomentsPremiumPurchaseAtomically(
  input: FinalizeMomentsPremiumPurchaseInput,
): Promise<FinalizeMomentsPremiumPurchaseResult> {
  const txnId = buildTxnId(input.orderId);
  const existingTxn = await CoinTransaction.findOne({ transactionId: txnId }).lean();
  if (existingTxn?.status === 'completed') {
    const membership = await MomentsPremiumMembership.findOne({ userId: input.userId }).lean();
    if (!membership) {
      throw new Error('MOMENTS_PREMIUM_MEMBERSHIP_MISSING_AFTER_COMPLETED_TXN');
    }
    return {
      alreadyProcessed: true,
      expiresAt: membership.expiresAt,
      membershipId: membership._id.toString(),
    };
  }

  const plan = await getMomentsPremiumPlanById(input.planId);
  const durationDays = input.durationDays ?? plan?.durationDays ?? 30;
  const durationMs = durationDays * 24 * 60 * 60 * 1000;
  const now = new Date();

  const session = await mongoose.startSession();
  let result: FinalizeMomentsPremiumPurchaseResult | null = null;

  try {
    await session.withTransaction(async () => {
      const user = await User.findById(input.userId).session(session);
      if (!user) throw new Error('User not found');

      const existingMembership = await MomentsPremiumMembership.findOne({
        userId: user._id,
      }).session(session);

      const baseExpiry =
        existingMembership &&
        existingMembership.status === 'active' &&
        existingMembership.expiresAt.getTime() > now.getTime()
          ? existingMembership.expiresAt
          : now;

      const expiresAt = new Date(baseExpiry.getTime() + durationMs);

      if (existingMembership) {
        existingMembership.status = 'active';
        existingMembership.planId = input.planId;
        existingMembership.startedAt = existingMembership.startedAt ?? now;
        existingMembership.expiresAt = expiresAt;
        existingMembership.lastPurchaseTxnId = txnId;
        existingMembership.razorpayOrderId = input.orderId;
        existingMembership.razorpayPaymentId = input.paymentId;
        await existingMembership.save({ session });
        result = {
          alreadyProcessed: false,
          expiresAt,
          membershipId: existingMembership._id.toString(),
        };
      } else {
        const [membership] = await MomentsPremiumMembership.create(
          [
            {
              userId: user._id,
              status: 'active',
              planId: input.planId,
              startedAt: now,
              expiresAt,
              lastPurchaseTxnId: txnId,
              razorpayOrderId: input.orderId,
              razorpayPaymentId: input.paymentId,
            },
          ],
          { session },
        );
        result = {
          alreadyProcessed: false,
          expiresAt,
          membershipId: membership._id.toString(),
        };
      }

      user.momentsPremiumExpiresAt = expiresAt;
      await user.save({ session });

      if (!existingTxn) {
        await CoinTransaction.create(
          [
            {
              transactionId: txnId,
              userId: user._id,
              type: 'credit',
              coins: 0,
              source: 'moments_premium_membership',
              description: `Moments Premium (${durationDays} days) for ₹${input.priceInr}`,
              paymentGatewayTransactionId: input.paymentId,
              paymentGatewayOrderId: input.orderId,
              paymentGatewayProvider: 'razorpay',
              status: 'completed',
            },
          ],
          { session },
        );
      } else if (existingTxn.status === 'pending') {
        existingTxn.status = 'completed';
        existingTxn.paymentGatewayTransactionId = input.paymentId;
        await existingTxn.save({ session });
      }
    });
  } finally {
    await session.endSession();
  }

  if (!result) throw new Error('MOMENTS_PREMIUM_PURCHASE_FINALIZATION_FAILED');

  await invalidateMomentsPremiumCache(input.userId);
  return result;
}

export async function createPendingMomentsPremiumTransaction(
  userId: string,
  orderId: string,
  priceInr: number,
  planId: string,
): Promise<void> {
  const txnId = buildTxnId(orderId);
  const existing = await CoinTransaction.findOne({ transactionId: txnId });
  if (existing) return;

  await CoinTransaction.create({
    transactionId: txnId,
    userId,
    type: 'credit',
    coins: 0,
    source: 'moments_premium_membership',
    description: `Moments Premium purchase (${planId}) for ₹${priceInr}`,
    paymentGatewayOrderId: orderId,
    paymentGatewayProvider: 'razorpay',
    status: 'pending',
  });
}

export function buildMomentsPremiumPurchaseTxnId(orderId: string): string {
  return buildTxnId(orderId);
}

export async function findPendingMomentsPremiumTransaction(orderId: string) {
  return CoinTransaction.findOne({ transactionId: buildTxnId(orderId) });
}
