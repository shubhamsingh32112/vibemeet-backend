import { User } from '../modules/user/user.model';
import { CoinTransaction } from '../modules/user/coin-transaction.model';
import mongoose from 'mongoose';

/**
 * 🔒 BALANCE INTEGRITY CHECK
 *
 * Verifies that User.coins matches the ledger-derived balance
 * (sum of credits − sum of debits) from CoinTransaction.
 *
 * Called after every economic mutation:
 *   - billing settlement
 *   - admin coin adjustment
 *   - refund
 *   - withdrawal approval
 *   - task reward claim
 *   - welcome bonus
 *   - chat pre-send
 *
 * Returns the expected balance and whether a mismatch was detected.
 * NEVER blocks the calling operation — logs and returns only.
 */
export interface BalanceCheckResult {
  userId: string;
  actualBalance: number;
  expectedBalance: number;
  mismatch: boolean;
  discrepancy: number;
}

export async function verifyUserBalance(
  userId: string | mongoose.Types.ObjectId
): Promise<BalanceCheckResult> {
  if (mongoose.connection.readyState !== 1) {
    // Ignore checks during shutdown/tests teardown when Mongo has disconnected.
    return {
      userId: userId.toString(),
      actualBalance: 0,
      expectedBalance: 0,
      mismatch: false,
      discrepancy: 0,
    };
  }

  try {
    const user = await User.findById(userId).lean();
    if (!user) {
      return {
        userId: userId.toString(),
        actualBalance: 0,
        expectedBalance: 0,
        mismatch: false,
        discrepancy: 0,
      };
    }

    const agg = await CoinTransaction.aggregate([
      {
        $match: {
          userId: new mongoose.Types.ObjectId(userId.toString()),
          status: 'completed',
        },
      },
      {
        $group: {
          _id: '$type',
          total: { $sum: '$coins' },
        },
      },
    ]);

    const credits = agg.find((a: any) => a._id === 'credit')?.total || 0;
    const debits = agg.find((a: any) => a._id === 'debit')?.total || 0;
    const expectedBalance = credits - debits;
    const actualBalance = user.coins;
    const discrepancy = actualBalance - expectedBalance;
    const mismatch = Math.abs(discrepancy) > 1; // allow ±1 for rounding

    if (mismatch) {
      console.error(
        `🚨 BALANCE MISMATCH for user ${userId}: ` +
          `actual=${actualBalance}, expected=${expectedBalance}, ` +
          `discrepancy=${discrepancy}`
      );
    }

    return {
      userId: userId.toString(),
      actualBalance,
      expectedBalance,
      mismatch,
      discrepancy,
    };
  } catch (err) {
    const errName = err instanceof Error ? err.name : '';
    const errMsg = err instanceof Error ? err.message : String(err);
    const isShutdownNoise =
      errName === 'MongoClientClosedError' ||
      errMsg.includes('client was closed') ||
      errMsg.includes('Connection pool for');

    if (!isShutdownNoise) {
      console.error(`⚠️ [BALANCE CHECK] Error checking user ${userId}:`, err);
    }
    return {
      userId: userId.toString(),
      actualBalance: 0,
      expectedBalance: 0,
      mismatch: false,
      discrepancy: 0,
    };
  }
}

/**
 * Batch balance check for multiple users.
 * Used by admin health / audit endpoints.
 */
export async function batchVerifyBalances(
  limit: number = 50
): Promise<{
  totalChecked: number;
  mismatchCount: number;
  mismatches: BalanceCheckResult[];
}> {
  const users = await User.find({ coins: { $gt: 0 } })
    .select('_id coins')
    .limit(limit)
    .lean();

  const results: BalanceCheckResult[] = [];
  let mismatchCount = 0;

  for (const u of users) {
    const result = await verifyUserBalance(u._id);
    if (result.mismatch) {
      mismatchCount++;
      results.push(result);
    }
  }

  return {
    totalChecked: users.length,
    mismatchCount,
    mismatches: results,
  };
}
