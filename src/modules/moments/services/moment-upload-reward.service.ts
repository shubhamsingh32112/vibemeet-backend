import mongoose from 'mongoose';
import { getMomentsConfig } from '../../../config/moments';
import { getIO } from '../../availability/availability.socket';
import { Creator } from '../../creator/creator.model';
import { CoinTransaction } from '../../user/coin-transaction.model';
import { User } from '../../user/user.model';
import { verifyUserBalance } from '../../../utils/balance-integrity';
import { logError, logInfo } from '../../../utils/logger';

function isDuplicateKeyError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.includes('duplicate key') || err.message.includes('E11000'))
  );
}

function isInvalidSourceEnumError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('moment_upload_reward');
}

async function createUploadRewardTransaction(input: {
  transactionId: string;
  userId: mongoose.Types.ObjectId;
  coins: number;
  momentType: 'photo' | 'video';
}): Promise<void> {
  const base = {
    transactionId: input.transactionId,
    userId: input.userId,
    type: 'credit' as const,
    coins: input.coins,
    description:
      input.momentType === 'photo'
        ? 'Reward for uploading a moment photo'
        : 'Reward for uploading a moment reel',
    status: 'completed' as const,
  };

  try {
    await CoinTransaction.create({
      ...base,
      source: 'moment_upload_reward',
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw err;
    if (isInvalidSourceEnumError(err)) {
      await CoinTransaction.create({
        ...base,
        source: 'creator_task',
      });
      return;
    }
    throw err;
  }
}

export function resolveMomentUploadRewardCoins(type: 'photo' | 'video'): number {
  const cfg = getMomentsConfig();
  const raw =
    type === 'photo'
      ? cfg.photoUploadRewardCoins ?? 10
      : cfg.videoUploadRewardCoins ?? 30;
  const coins = Number(raw);
  if (!Number.isFinite(coins) || coins <= 0) return 0;
  return Math.floor(coins);
}

export async function creditMomentUploadReward(input: {
  userId: mongoose.Types.ObjectId;
  creatorId: mongoose.Types.ObjectId;
  momentId: string;
  momentType: 'photo' | 'video';
}): Promise<{ coinsCredited: number; newBalance: number } | null> {
  const rewardCoins = resolveMomentUploadRewardCoins(input.momentType);
  if (rewardCoins <= 0) return null;

  const transactionId = `moment_upload_reward_${input.momentId}`;

  const existing = await CoinTransaction.findOne({ transactionId }).lean();
  if (existing) {
    const user = await User.findById(input.userId).select('coins').lean();
    return {
      coinsCredited: existing.coins,
      newBalance: user?.coins ?? 0,
    };
  }

  const user = await User.findById(input.userId);
  const creator = await Creator.findById(input.creatorId);
  if (!user || !creator) {
    throw new Error('User or creator not found for moment upload reward');
  }

  try {
    await createUploadRewardTransaction({
      transactionId,
      userId: user._id,
      coins: rewardCoins,
      momentType: input.momentType,
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) {
      throw err;
    }
    const duplicate = await CoinTransaction.findOne({ transactionId }).lean();
    const latestUser = await User.findById(input.userId).select('coins').lean();
    return {
      coinsCredited: duplicate?.coins ?? rewardCoins,
      newBalance: latestUser?.coins ?? 0,
    };
  }

  user.coins = (user.coins || 0) + rewardCoins;
  creator.earningsCoins = (creator.earningsCoins || 0) + rewardCoins;
  await user.save();
  await creator.save();

  logInfo('Moment upload reward credited', {
    userId: user._id.toString(),
    momentId: input.momentId,
    momentType: input.momentType,
    rewardCoins,
  });

  verifyUserBalance(user._id).catch(() => {});

  try {
    if (user.firebaseUid) {
      const io = getIO();
      io?.to(`user:${user.firebaseUid}`).emit('coins_updated', {
        userId: user._id.toString(),
        coins: user.coins,
      });
    }
  } catch (err) {
    logError('Failed to emit coins_updated for moment upload reward', err);
  }

  return {
    coinsCredited: rewardCoins,
    newBalance: user.coins,
  };
}
