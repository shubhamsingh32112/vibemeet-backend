import mongoose from 'mongoose';
import { User } from '../user/user.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { getIO } from '../../config/socket';
import { verifyUserBalance } from '../../utils/balance-integrity';
import { logError, logInfo, logWarning } from '../../utils/logger';
import type { CoinTransactionSourceForReward } from './task-keys';
import {
  ensureUserRewardProgress,
  getClaimedAt,
} from './user-reward-progress.model';
import { getOrCreateConsumerRewardConfig } from './consumer-reward-config.model';
import type { ConsumerRewardTaskKey } from './task-keys';
import {
  recordRewardCreditAlready,
  recordRewardCreditFail,
  recordRewardCreditSuccess,
  trackRewardIssuance,
} from './reward-metrics';

export class ConsumerRewardError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'ConsumerRewardError';
  }
}

function isDuplicateKeyError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: number }).code === 11000
  );
}

export type CreditResult = {
  success: true;
  alreadyClaimed: boolean;
  coinsCredited: number;
  balance: number;
};

async function emitCoinsUpdated(
  firebaseUid: string,
  userId: mongoose.Types.ObjectId,
  coins: number
): Promise<void> {
  try {
    const io = getIO();
    io.to(`user:${firebaseUid}`).emit('coins_updated', {
      userId: userId.toString(),
      coins,
    });
  } catch (err) {
    logError('Failed to emit coins_updated for consumer reward', err as Error);
  }
}

/**
 * Atomic lifetime once-task credit with progress claim key + unique txn id.
 */
export async function creditOnceTaskReward(input: {
  userId: mongoose.Types.ObjectId;
  taskKey: ConsumerRewardTaskKey;
  progressClaimKey?: string;
  transactionId: string;
  coins: number;
  source: CoinTransactionSourceForReward;
  description: string;
}): Promise<CreditResult> {
  const progressKey = input.progressClaimKey ?? input.taskKey;
  const session = await mongoose.startSession();
  let result: CreditResult | null = null;
  let firebaseUid: string | null = null;

  try {
    await session.withTransaction(async () => {
      const user = await User.findById(input.userId)
        .select('_id role coins firebaseUid')
        .session(session);
      if (!user) {
        throw new ConsumerRewardError('User not found', 404);
      }
      if (user.role !== 'user') {
        throw new ConsumerRewardError(
          'Rewards only available for users',
          403,
          'ROLE'
        );
      }
      firebaseUid = user.firebaseUid;

      const progress = await ensureUserRewardProgress(user._id, session);
      if (getClaimedAt(progress, progressKey)) {
        result = {
          success: true,
          alreadyClaimed: true,
          coinsCredited: 0,
          balance: user.coins ?? 0,
        };
        return;
      }

      if (input.coins <= 0) {
        throw new ConsumerRewardError('Invalid reward amount', 500, 'CONFIG');
      }

      try {
        await CoinTransaction.create(
          [
            {
              transactionId: input.transactionId,
              userId: user._id,
              type: 'credit',
              coins: input.coins,
              source: input.source,
              description: input.description,
              status: 'completed',
            },
          ],
          { session }
        );
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          result = {
            success: true,
            alreadyClaimed: true,
            coinsCredited: 0,
            balance: user.coins ?? 0,
          };
          return;
        }
        throw err;
      }

      const mark = await User.updateOne(
        { _id: user._id, role: 'user' },
        { $inc: { coins: input.coins } },
        { session }
      );
      if (mark.modifiedCount !== 1) {
        throw new ConsumerRewardError('Failed to credit wallet', 500, 'WALLET');
      }

      await progress.updateOne(
        {
          $set: {
            [`claimed.${progressKey}`]: new Date(),
          },
        },
        { session }
      );

      const bal = await User.findById(user._id).select('coins').session(session);
      result = {
        success: true,
        alreadyClaimed: false,
        coinsCredited: input.coins,
        balance: bal?.coins ?? (user.coins ?? 0) + input.coins,
      };
    });
  } catch (err) {
    if (err instanceof ConsumerRewardError && err.code) {
      recordRewardCreditFail(input.taskKey, err.code);
    } else {
      recordRewardCreditFail(input.taskKey, 'ERROR');
    }
    throw err;
  } finally {
    await session.endSession();
  }

  if (!result) {
    recordRewardCreditFail(input.taskKey, 'WALLET');
    throw new ConsumerRewardError('Failed to credit reward', 500, 'WALLET');
  }

  if (result.alreadyClaimed) {
    recordRewardCreditAlready(input.taskKey);
  } else if (result.coinsCredited > 0) {
    recordRewardCreditSuccess(input.taskKey, result.coinsCredited);
    void trackRewardIssuance(result.coinsCredited);
    if (firebaseUid) {
      await emitCoinsUpdated(firebaseUid, input.userId, result.balance);
    }
    verifyUserBalance(input.userId).catch(() => {});
    logInfo('Consumer reward credited', {
      userId: input.userId.toString(),
      taskKey: input.taskKey,
      coins: result.coinsCredited,
      transactionId: input.transactionId,
    });
  }

  return result;
}

/**
 * Daily task credit (watch/like) — marks daily flag + unique txn by IST date.
 */
export async function creditDailyTaskReward(input: {
  userId: mongoose.Types.ObjectId;
  taskKey: 'watch_free_moments' | 'like_moments';
  dateKey: string;
  transactionId: string;
  coins: number;
  source: CoinTransactionSourceForReward;
  description: string;
}): Promise<CreditResult> {
  const session = await mongoose.startSession();
  let result: CreditResult | null = null;
  let firebaseUid: string | null = null;
  const dailyFlag =
    input.taskKey === 'watch_free_moments' ? 'watchClaimed' : 'likeClaimed';

  try {
    await session.withTransaction(async () => {
      const user = await User.findById(input.userId)
        .select('_id role coins firebaseUid')
        .session(session);
      if (!user || user.role !== 'user') {
        throw new ConsumerRewardError(
          'Rewards only available for users',
          403,
          'ROLE'
        );
      }
      firebaseUid = user.firebaseUid;

      const progress = await ensureUserRewardProgress(user._id, session);
      if (
        progress.daily.dateKey === input.dateKey &&
        progress.daily[dailyFlag]
      ) {
        result = {
          success: true,
          alreadyClaimed: true,
          coinsCredited: 0,
          balance: user.coins ?? 0,
        };
        return;
      }

      try {
        await CoinTransaction.create(
          [
            {
              transactionId: input.transactionId,
              userId: user._id,
              type: 'credit',
              coins: input.coins,
              source: input.source,
              description: input.description,
              status: 'completed',
            },
          ],
          { session }
        );
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          result = {
            success: true,
            alreadyClaimed: true,
            coinsCredited: 0,
            balance: user.coins ?? 0,
          };
          return;
        }
        throw err;
      }

      const wallet = await User.updateOne(
        { _id: user._id, role: 'user' },
        { $inc: { coins: input.coins } },
        { session }
      );
      if (wallet.modifiedCount !== 1) {
        throw new ConsumerRewardError('Failed to credit wallet', 500, 'WALLET');
      }

      if (progress.daily.dateKey !== input.dateKey) {
        progress.daily = {
          dateKey: input.dateKey,
          viewedMomentIds: [],
          likedMomentIds: [],
          watchClaimed: false,
          likeClaimed: false,
        };
      }
      progress.daily[dailyFlag] = true;
      await progress.save({ session });

      const bal = await User.findById(user._id).select('coins').session(session);
      result = {
        success: true,
        alreadyClaimed: false,
        coinsCredited: input.coins,
        balance: bal?.coins ?? (user.coins ?? 0) + input.coins,
      };
    });
  } catch (err) {
    if (err instanceof ConsumerRewardError && err.code) {
      recordRewardCreditFail(input.taskKey, err.code);
    } else {
      recordRewardCreditFail(input.taskKey, 'ERROR');
    }
    throw err;
  } finally {
    await session.endSession();
  }

  if (!result) {
    recordRewardCreditFail(input.taskKey, 'WALLET');
    throw new ConsumerRewardError('Failed to credit reward', 500, 'WALLET');
  }

  if (result.alreadyClaimed) {
    recordRewardCreditAlready(input.taskKey);
  } else if (result.coinsCredited > 0) {
    recordRewardCreditSuccess(input.taskKey, result.coinsCredited);
    void trackRewardIssuance(result.coinsCredited);
    if (firebaseUid) {
      await emitCoinsUpdated(firebaseUid, input.userId, result.balance);
    }
    verifyUserBalance(input.userId).catch(() => {});
  }

  return result;
}

export async function assertTaskEnabled(
  taskKey: Exclude<ConsumerRewardTaskKey, 'telegram_join'>
): Promise<{ coins: number; slice: Record<string, unknown> }> {
  const cfg = await getOrCreateConsumerRewardConfig();
  if (!cfg.enabled) {
    throw new ConsumerRewardError('Rewards disabled', 403, 'DISABLED');
  }
  const slice = cfg.tasks[taskKey];
  if (!slice?.enabled || !slice.coins || slice.coins < 1) {
    throw new ConsumerRewardError('Task disabled', 403, 'DISABLED');
  }
  return { coins: slice.coins, slice: slice as unknown as Record<string, unknown> };
}

/** Safe fire-and-forget wrapper used by domain hooks. */
export function safeRewardHook(
  label: string,
  fn: () => Promise<unknown>
): void {
  fn().catch((err) => {
    logWarning(`consumer reward hook failed: ${label}`, {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
