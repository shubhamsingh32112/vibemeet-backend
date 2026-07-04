import mongoose from 'mongoose';
import { CoinTransaction } from '../modules/user/coin-transaction.model';
import { User } from '../modules/user/user.model';
import { logWarning, logError } from './logger';

export type LedgerCoinsResult = {
  userId: string;
  actualCoins: number;
  expectedCoins: number;
  discrepancy: number;
  repaired: boolean;
};

/**
 * Canonical coins = completed ledger credits - completed ledger debits.
 *
 * Why: never show an inflated/misleading balance in UI that later "drops"
 * when reconciliation repairs `User.coins`.
 */
export async function getCanonicalCoinsAndRepairIfNeeded(
  userId: mongoose.Types.ObjectId,
  actualCoins: number,
  opts?: { tolerance?: number }
): Promise<LedgerCoinsResult> {
  const tolerance = Math.max(0, opts?.tolerance ?? 1);
  const userIdStr = userId.toString();

  try {
    const agg = await CoinTransaction.aggregate([
      {
        $match: {
          userId: new mongoose.Types.ObjectId(userIdStr),
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
    // Coins cannot go below 0 (User.coins min: 0); clamp ledger-derived balance.
    const expectedCoins = Math.max(0, credits - debits);
    const discrepancy = (Number(actualCoins) || 0) - expectedCoins;

    if (Math.abs(discrepancy) <= tolerance) {
      return {
        userId: userIdStr,
        actualCoins: Number(actualCoins) || 0,
        expectedCoins,
        discrepancy,
        repaired: false,
      };
    }

    // Repair immediately so subsequent reads/sockets reflect canonical value.
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          coins: expectedCoins,
        },
      }
    ).catch(() => {});

    logWarning('ledger_coins_read_repair_applied', {
      userId: userIdStr,
      actualCoins: Number(actualCoins) || 0,
      expectedCoins,
      discrepancy,
    });

    return {
      userId: userIdStr,
      actualCoins: Number(actualCoins) || 0,
      expectedCoins,
      discrepancy,
      repaired: true,
    };
  } catch (err) {
    logError('ledger_coins_compute_failed', err, { userId: userIdStr });
    return {
      userId: userIdStr,
      actualCoins: Number(actualCoins) || 0,
      expectedCoins: Number(actualCoins) || 0,
      discrepancy: 0,
      repaired: false,
    };
  }
}

