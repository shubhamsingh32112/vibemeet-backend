import { User } from '../modules/user/user.model';
import { CoinTransaction } from '../modules/user/coin-transaction.model';
import mongoose from 'mongoose';
import {
  BILLING_BALANCE_MISMATCH_REPAIR_QUEUE_KEY,
  billingBalanceMismatchRepairPayloadKey,
  getRedis,
} from '../config/redis';
import { recordBillingMetric } from './monitoring';
import { logError, logWarning } from './logger';

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

const MISMATCH_LOG_THROTTLE_MS = Math.max(
  5_000,
  parseInt(process.env.BILLING_BALANCE_MISMATCH_LOG_THROTTLE_MS || '60000', 10) || 60_000
);
const mismatchLogCache = new Map<string, number>();

function classifyMismatch(discrepancy: number): 'wallet_over' | 'wallet_under' | 'balanced' {
  if (discrepancy > 0) return 'wallet_over';
  if (discrepancy < 0) return 'wallet_under';
  return 'balanced';
}

async function enqueueBalanceMismatchRepairTask(
  userId: string,
  actualBalance: number,
  expectedBalance: number,
  discrepancy: number
): Promise<void> {
  try {
    const redis = getRedis();
    const now = Date.now();
    const payload = {
      userId,
      actualBalance,
      expectedBalance,
      discrepancy,
      mismatchClass: classifyMismatch(discrepancy),
      enqueuedAt: now,
    };
    await redis.setex(
      billingBalanceMismatchRepairPayloadKey(userId),
      24 * 60 * 60,
      JSON.stringify(payload)
    );
    await redis.zadd(BILLING_BALANCE_MISMATCH_REPAIR_QUEUE_KEY, now, userId);
    recordBillingMetric('balance_mismatch_repair_enqueued_total', 1, {
      userId,
      class: payload.mismatchClass,
    });
  } catch {
    recordBillingMetric('balance_mismatch_repair_enqueue_failed_total', 1, { userId });
  }
}

export async function verifyUserBalance(
  userId: string | mongoose.Types.ObjectId
): Promise<BalanceCheckResult> {
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

    const mismatchClass = classifyMismatch(discrepancy);
    recordBillingMetric('balance_mismatch_total', mismatch ? 1 : 0, {
      userId: userId.toString(),
      class: mismatchClass,
    });

    if (mismatch) {
      const userIdStr = userId.toString();
      const now = Date.now();
      const cacheKey = `${userIdStr}:${mismatchClass}`;
      const lastLogAt = mismatchLogCache.get(cacheKey) || 0;
      const shouldLog = now - lastLogAt >= MISMATCH_LOG_THROTTLE_MS;
      if (shouldLog) {
        mismatchLogCache.set(cacheKey, now);
        logWarning('BALANCE MISMATCH detected', {
          userId: userIdStr,
          actualBalance,
          expectedBalance,
          discrepancy,
          mismatchClass,
        });
      }
      await enqueueBalanceMismatchRepairTask(userIdStr, actualBalance, expectedBalance, discrepancy);
    }

    return {
      userId: userId.toString(),
      actualBalance,
      expectedBalance,
      mismatch,
      discrepancy,
    };
  } catch (err) {
    logError('BALANCE CHECK failed', err, {
      userId: userId.toString(),
    });
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
