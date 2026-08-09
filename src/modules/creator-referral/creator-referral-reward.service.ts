/**
 * Creator affiliate referral rewards.
 * Qualifiers: telegramRewardClaimed + any settled call (duration > 0).
 * Credits creator User.coins once via unique ledger txn.
 */

import mongoose, { Types } from 'mongoose';
import { User } from '../user/user.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { CallHistory } from '../billing/call-history.model';
import { CreatorReferralEdge } from './creator-referral-edge.model';
import { getOrCreateCreatorReferralConfig } from './creator-referral-config.model';
import { getIO } from '../../config/socket';
import { logError, logInfo } from '../../utils/logger';
import { verifyUserBalance } from '../../utils/balance-integrity';

export function creatorReferralRewardTransactionId(
  creatorUserId: Types.ObjectId | string,
  referredUserId: Types.ObjectId | string
): string {
  return `creator_referral_reward_${creatorUserId.toString()}_${referredUserId.toString()}`;
}

function isDuplicateKeyError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: number }).code === 11000
  );
}

async function emitCreatorCoinsUpdated(
  firebaseUid: string | null | undefined,
  userId: Types.ObjectId,
  balance: number
): Promise<void> {
  if (!firebaseUid) return;
  try {
    const io = getIO();
    io.to(`user:${firebaseUid}`).emit('coins_updated', {
      userId: userId.toString(),
      coins: balance,
      balance,
    });
  } catch (err) {
    logError('Failed to emit coins_updated for creator referral reward', err as Error);
  }
}

async function applicantHasSettledCall(userId: Types.ObjectId): Promise<boolean> {
  const row = await CallHistory.findOne({
    ownerUserId: userId,
    ownerRole: 'user',
    settlementStatus: 'settled',
    durationSeconds: { $gt: 0 },
  })
    .select('_id')
    .lean();
  return !!row;
}

/**
 * Create CreatorReferralEdge after a successful creator-code attach.
 * Backfills telegram/call flags from existing user state, then tryCredit.
 */
export async function createCreatorReferralEdgeAfterAttach(input: {
  creatorUserId: Types.ObjectId;
  referredUserId: Types.ObjectId;
  referralCodeUsed: string;
  telegramAlreadyClaimed?: boolean;
}): Promise<void> {
  const now = new Date();
  let telegramJoinedAt: Date | null = input.telegramAlreadyClaimed ? now : null;
  if (!telegramJoinedAt) {
    const u = await User.findById(input.referredUserId)
      .select('telegramRewardClaimed')
      .lean();
    if (u?.telegramRewardClaimed) {
      telegramJoinedAt = now;
    }
  }

  let videoCallCompletedAt: Date | null = null;
  if (await applicantHasSettledCall(input.referredUserId)) {
    videoCallCompletedAt = now;
  }

  try {
    await CreatorReferralEdge.create({
      creatorUserId: input.creatorUserId,
      referredUserId: input.referredUserId,
      referralCodeUsed: input.referralCodeUsed,
      telegramJoinedAt,
      videoCallCompletedAt,
      creatorRewardedAt: null,
      creatorRewardCoins: null,
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) {
      logError('CreatorReferralEdge.create failed', err as Error, {
        creatorUserId: input.creatorUserId.toString(),
        referredUserId: input.referredUserId.toString(),
      });
      throw err;
    }
  }

  await tryCreditCreatorReferral(input.creatorUserId, input.referredUserId);
}

export async function markCreatorReferralTelegramJoined(
  referredUserId: Types.ObjectId
): Promise<void> {
  const edge = await CreatorReferralEdge.findOneAndUpdate(
    { referredUserId, telegramJoinedAt: null },
    { $set: { telegramJoinedAt: new Date() } },
    { new: true }
  );
  if (!edge) {
    const existing = await CreatorReferralEdge.findOne({ referredUserId })
      .select('creatorUserId')
      .lean();
    if (!existing) return;
    await tryCreditCreatorReferral(existing.creatorUserId, referredUserId);
    return;
  }
  await tryCreditCreatorReferral(edge.creatorUserId, referredUserId);
}

export async function markCreatorReferralVideoCallCompleted(
  referredUserId: Types.ObjectId
): Promise<void> {
  const edge = await CreatorReferralEdge.findOneAndUpdate(
    { referredUserId, videoCallCompletedAt: null },
    { $set: { videoCallCompletedAt: new Date() } },
    { new: true }
  );
  if (!edge) {
    const existing = await CreatorReferralEdge.findOne({ referredUserId })
      .select('creatorUserId')
      .lean();
    if (!existing) return;
    await tryCreditCreatorReferral(existing.creatorUserId, referredUserId);
    return;
  }
  await tryCreditCreatorReferral(edge.creatorUserId, referredUserId);
}

/**
 * Idempotent payout when both qualifiers are met and config is enabled.
 */
export async function tryCreditCreatorReferral(
  creatorUserId: Types.ObjectId,
  referredUserId: Types.ObjectId
): Promise<boolean> {
  const cfg = await getOrCreateCreatorReferralConfig();
  if (!cfg.enabled || cfg.rewardCoins < 1) {
    return false;
  }

  const edge = await CreatorReferralEdge.findOne({
    creatorUserId,
    referredUserId,
  }).lean();
  if (!edge) return false;
  if (edge.creatorRewardedAt) return false;
  if (!edge.telegramJoinedAt || !edge.videoCallCompletedAt) return false;

  const rewardCoins = cfg.rewardCoins;
  const txnId = creatorReferralRewardTransactionId(creatorUserId, referredUserId);

  const existingTxn = await CoinTransaction.findOne({ transactionId: txnId })
    .select('_id')
    .lean();
  if (existingTxn) {
    await CreatorReferralEdge.updateOne(
      { _id: edge._id, creatorRewardedAt: null },
      {
        $set: {
          creatorRewardedAt: new Date(),
          creatorRewardCoins: rewardCoins,
        },
      }
    );
    return true;
  }

  const session = await mongoose.startSession();
  let credited = false;
  let newBalance = 0;
  let creatorFirebaseUid: string | null = null;

  try {
    await session.withTransaction(async () => {
      const cas = await CreatorReferralEdge.findOneAndUpdate(
        {
          _id: edge._id,
          creatorRewardedAt: null,
          telegramJoinedAt: { $ne: null },
          videoCallCompletedAt: { $ne: null },
        },
        {
          $set: {
            creatorRewardedAt: new Date(),
            creatorRewardCoins: rewardCoins,
          },
        },
        { new: true, session }
      );
      if (!cas) {
        return;
      }

      try {
        await CoinTransaction.create(
          [
            {
              transactionId: txnId,
              userId: creatorUserId,
              type: 'credit',
              coins: rewardCoins,
              source: 'creator_referral_reward',
              description: `Creator referral reward (${referredUserId.toString()})`,
              status: 'completed',
            },
          ],
          { session }
        );
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          return;
        }
        throw err;
      }

      const updated = await User.findOneAndUpdate(
        { _id: creatorUserId },
        { $inc: { coins: rewardCoins } },
        { new: true, session }
      ).select('coins firebaseUid');

      if (!updated) {
        throw new Error('Creator user not found for referral reward');
      }

      credited = true;
      newBalance = updated.coins ?? 0;
      creatorFirebaseUid = updated.firebaseUid ?? null;
    });
  } finally {
    await session.endSession();
  }

  if (credited) {
    await emitCreatorCoinsUpdated(creatorFirebaseUid, creatorUserId, newBalance);
    verifyUserBalance(creatorUserId).catch((err) => {
      logError('creator referral balance integrity check failed', err as Error, {
        creatorUserId: creatorUserId.toString(),
      });
    });
    logInfo('Creator referral reward credited', {
      creatorUserId: creatorUserId.toString(),
      referredUserId: referredUserId.toString(),
      coins: rewardCoins,
      balance: newBalance,
    });
  }

  return credited;
}

/** Non-blocking wrappers for hooks. */
export function onCreatorReferralTelegramClaimed(referredUserId: Types.ObjectId): void {
  void markCreatorReferralTelegramJoined(referredUserId).catch((err) => {
    logError('markCreatorReferralTelegramJoined failed', err as Error, {
      referredUserId: referredUserId.toString(),
    });
  });
}

export function onCreatorReferralCallSettled(referredUserId: Types.ObjectId): void {
  void markCreatorReferralVideoCallCompleted(referredUserId).catch((err) => {
    logError('markCreatorReferralVideoCallCompleted failed', err as Error, {
      referredUserId: referredUserId.toString(),
    });
  });
}

/**
 * Re-attempt payout for edges that completed both tasks but were unpaid
 * (e.g. config was disabled). Called after admin re-enables config.
 */
export async function reconcileUnpaidCreatorReferrals(limit = 200): Promise<number> {
  const cfg = await getOrCreateCreatorReferralConfig();
  if (!cfg.enabled) return 0;

  const unpaid = await CreatorReferralEdge.find({
    creatorRewardedAt: null,
    telegramJoinedAt: { $ne: null },
    videoCallCompletedAt: { $ne: null },
  })
    .select('creatorUserId referredUserId')
    .limit(limit)
    .lean();

  let paid = 0;
  for (const row of unpaid) {
    const ok = await tryCreditCreatorReferral(row.creatorUserId, row.referredUserId);
    if (ok) paid += 1;
  }
  return paid;
}
