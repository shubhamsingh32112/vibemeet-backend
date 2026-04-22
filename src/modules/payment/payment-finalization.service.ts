import mongoose from 'mongoose';
import { CoinTransaction, type ICoinTransaction } from '../user/coin-transaction.model';
import { User } from '../user/user.model';
import { logInfo } from '../../utils/logger';
import { recordPaymentMetric } from '../../utils/monitoring';

export interface FinalizePaymentInput {
  orderId: string;
  paymentId: string;
  expectedUserId?: string;
}

export interface FinalizePaymentResult {
  status: 'completed' | 'already_completed';
  transaction: ICoinTransaction;
  updatedUserCoins: number;
  coinsAdded: number;
}

export async function finalizePaymentAtomically(
  input: FinalizePaymentInput
): Promise<FinalizePaymentResult> {
  const { orderId, paymentId, expectedUserId } = input;
  const startedAt = Date.now();
  const selectors = [
    { transactionId: `pay_${orderId}` },
    { transactionId: `razorpay_${orderId}` }, // backward compatibility with older rows
    { paymentGatewayOrderId: orderId },
  ];
  const session = await mongoose.startSession();

  try {
    let result: FinalizePaymentResult | null = null;

    await session.withTransaction(async () => {
      const currentTx = await CoinTransaction.findOne({ $or: selectors }).session(session);
      if (!currentTx) {
        throw new Error('TRANSACTION_NOT_FOUND');
      }

      const txUserId = currentTx.userId.toString();
      if (expectedUserId && txUserId !== expectedUserId) {
        throw new Error('TRANSACTION_USER_MISMATCH');
      }

      const user = await User.findById(currentTx.userId).session(session);
      if (!user) {
        throw new Error('USER_NOT_FOUND');
      }

      const updatedTx = await CoinTransaction.findOneAndUpdate(
        {
          _id: currentTx._id,
          status: { $ne: 'completed' },
        },
        {
          $set: {
            status: 'completed',
            paymentGatewayTransactionId: paymentId,
            paymentGatewayOrderId: orderId,
            paymentGatewayProvider: 'razorpay',
          },
        },
        { new: true, session }
      );

      if (!updatedTx) {
        const alreadyCompleted = await CoinTransaction.findById(currentTx._id).session(session);
        if (!alreadyCompleted) {
          throw new Error('TRANSACTION_NOT_FOUND');
        }
        recordPaymentMetric('finalize.already_completed', 1);
        recordPaymentMetric('finalize.duration_ms', Date.now() - startedAt, {
          status: 'already_completed',
        });
        logInfo('Payment finalization idempotent hit', {
          orderId,
          paymentId,
          transactionId: alreadyCompleted._id.toString(),
        });
        result = {
          status: 'already_completed',
          transaction: alreadyCompleted,
          updatedUserCoins: user.coins || 0,
          coinsAdded: 0,
        };
        return;
      }

      const userUpdate = await User.findByIdAndUpdate(
        user._id,
        {
          $inc: { coins: updatedTx.coins },
        },
        {
          new: true,
          session,
        }
      );

      if (!userUpdate) {
        throw new Error('USER_NOT_FOUND');
      }

      result = {
        status: 'completed',
        transaction: updatedTx,
        updatedUserCoins: userUpdate.coins || 0,
        coinsAdded: updatedTx.coins,
      };
      recordPaymentMetric('finalize.completed', 1);
      recordPaymentMetric('finalize.coins_added', updatedTx.coins);
      recordPaymentMetric('finalize.duration_ms', Date.now() - startedAt, {
        status: 'completed',
      });
      logInfo('Payment finalized and coins credited', {
        orderId,
        paymentId,
        userId: user._id.toString(),
        coinsAdded: updatedTx.coins,
      });
    });

    if (!result) {
      recordPaymentMetric('finalize.failed', 1, { reason: 'unknown_result' });
      throw new Error('FINALIZE_PAYMENT_UNKNOWN_ERROR');
    }

    return result;
  } finally {
    await session.endSession();
  }
}
