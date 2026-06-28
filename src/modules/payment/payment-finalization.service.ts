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

const buildPendingTransactionId = (orderId: string) => `pay_${orderId}`;
const buildPendingBonusTransactionId = (orderId: string) => `pay_bonus_${orderId}`;

const getOrderTransactionSelectors = (orderId: string) => [
  { transactionId: buildPendingTransactionId(orderId) },
  { transactionId: `razorpay_${orderId}` },
  { paymentGatewayOrderId: orderId },
];

async function completePendingTransaction(
  tx: ICoinTransaction,
  orderId: string,
  paymentId: string,
  session: mongoose.ClientSession,
): Promise<ICoinTransaction | null> {
  return CoinTransaction.findOneAndUpdate(
    {
      _id: tx._id,
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
    { new: true, session },
  );
}

export async function finalizePaymentAtomically(
  input: FinalizePaymentInput
): Promise<FinalizePaymentResult> {
  const { orderId, paymentId, expectedUserId } = input;
  const startedAt = Date.now();
  const selectors = getOrderTransactionSelectors(orderId);
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

      const updatedTx = await completePendingTransaction(
        currentTx,
        orderId,
        paymentId,
        session,
      );

      if (!updatedTx) {
        const alreadyCompleted = await CoinTransaction.findById(currentTx._id).session(session);
        if (!alreadyCompleted) {
          throw new Error('TRANSACTION_NOT_FOUND');
        }

        let bonusCoinsAdded = 0;
        let updatedUserCoins = user.coins || 0;

        const bonusTx = await CoinTransaction.findOne({
          transactionId: buildPendingBonusTransactionId(orderId),
        }).session(session);

        if (bonusTx && bonusTx.status !== 'completed') {
          const completedBonus = await completePendingTransaction(
            bonusTx,
            orderId,
            paymentId,
            session,
          );
          if (completedBonus) {
            bonusCoinsAdded = completedBonus.coins;
            const userUpdate = await User.findByIdAndUpdate(
              user._id,
              { $inc: { coins: bonusCoinsAdded } },
              { new: true, session },
            );
            if (!userUpdate) {
              throw new Error('USER_NOT_FOUND');
            }
            updatedUserCoins = userUpdate.coins || 0;
            logInfo('Payment bonus finalized on idempotent retry', {
              orderId,
              paymentId,
              bonusCoins: bonusCoinsAdded,
            });
          }
        }

        recordPaymentMetric('finalize.already_completed', 1);
        recordPaymentMetric('finalize.duration_ms', Date.now() - startedAt, {
          status: 'already_completed',
        });
        logInfo('Payment finalization idempotent hit', {
          orderId,
          paymentId,
          transactionId: alreadyCompleted._id.toString(),
          bonusCoinsAdded,
        });
        result = {
          status: 'already_completed',
          transaction: alreadyCompleted,
          updatedUserCoins,
          coinsAdded: bonusCoinsAdded,
        };
        return;
      }

      let totalCoinsAdded = updatedTx.coins;

      const bonusTx = await CoinTransaction.findOne({
        transactionId: buildPendingBonusTransactionId(orderId),
      }).session(session);

      if (bonusTx && bonusTx.status !== 'completed') {
        const completedBonus = await completePendingTransaction(
          bonusTx,
          orderId,
          paymentId,
          session,
        );
        if (completedBonus) {
          totalCoinsAdded += completedBonus.coins;
        }
      }

      const userUpdate = await User.findByIdAndUpdate(
        user._id,
        {
          $inc: { coins: totalCoinsAdded },
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
        coinsAdded: totalCoinsAdded,
      };
      recordPaymentMetric('finalize.completed', 1);
      recordPaymentMetric('finalize.coins_added', totalCoinsAdded);
      recordPaymentMetric('finalize.duration_ms', Date.now() - startedAt, {
        status: 'completed',
      });
      logInfo('Payment finalized and coins credited', {
        orderId,
        paymentId,
        userId: user._id.toString(),
        baseCoins: updatedTx.coins,
        bonusCoins: bonusTx?.coins ?? 0,
        coinsAdded: totalCoinsAdded,
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

export async function createPendingBonusCoinTransaction(
  userId: string,
  orderId: string,
  bonusCoins: number,
  bonusReason: string,
): Promise<void> {
  if (bonusCoins <= 0) return;
  const transactionId = buildPendingBonusTransactionId(orderId);
  const existing = await CoinTransaction.findOne({ transactionId });
  if (existing) return;

  const transaction = new CoinTransaction({
    transactionId,
    userId,
    type: 'credit',
    coins: bonusCoins,
    source: 'recharge_bonus',
    bonusReason,
    description: `Recharge bonus (${bonusReason}): ${bonusCoins} coins`,
    paymentGatewayOrderId: orderId,
    paymentGatewayProvider: 'razorpay',
    status: 'pending',
  });
  await transaction.save();
}
