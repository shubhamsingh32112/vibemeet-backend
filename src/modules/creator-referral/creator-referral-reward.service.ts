/**
 * Multi-stage creator affiliate referral rewards.
 * Stages: signup attach, telegram claim, first purchase (coins | VIP | moments premium).
 */

import mongoose, { Types } from 'mongoose';
import { User } from '../user/user.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { CreatorReferralEdge } from './creator-referral-edge.model';
import { getOrCreateCreatorReferralConfig } from './creator-referral-config.model';
import { getIO } from '../../config/socket';
import { logError, logInfo } from '../../utils/logger';
import { verifyUserBalance } from '../../utils/balance-integrity';

export type CreatorReferralStage = 'attach' | 'telegram' | 'purchase';

export function creatorReferralStageTransactionId(
  stage: CreatorReferralStage,
  creatorUserId: Types.ObjectId | string,
  referredUserId: Types.ObjectId | string
): string {
  return `creator_referral_${stage}_${creatorUserId.toString()}_${referredUserId.toString()}`;
}

/** @deprecated Legacy single-payout txn id. */
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

function isLegacyFullyPaid(edge: { creatorRewardedAt?: Date | null }): boolean {
  return !!edge.creatorRewardedAt;
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

type StageMeta = {
  rewardedAtField: 'attachRewardedAt' | 'telegramRewardedAt' | 'purchaseRewardedAt';
  rewardCoinsField: 'attachRewardCoins' | 'telegramRewardCoins' | 'purchaseRewardCoins';
  source:
    | 'creator_referral_attach_reward'
    | 'creator_referral_telegram_reward'
    | 'creator_referral_purchase_reward';
  description: string;
  configKey: 'attachCoins' | 'telegramCoins' | 'purchaseCoins';
};

const STAGE_META: Record<CreatorReferralStage, StageMeta> = {
  attach: {
    rewardedAtField: 'attachRewardedAt',
    rewardCoinsField: 'attachRewardCoins',
    source: 'creator_referral_attach_reward',
    description: 'Creator referral — signup',
    configKey: 'attachCoins',
  },
  telegram: {
    rewardedAtField: 'telegramRewardedAt',
    rewardCoinsField: 'telegramRewardCoins',
    source: 'creator_referral_telegram_reward',
    description: 'Creator referral — Telegram',
    configKey: 'telegramCoins',
  },
  purchase: {
    rewardedAtField: 'purchaseRewardedAt',
    rewardCoinsField: 'purchaseRewardCoins',
    source: 'creator_referral_purchase_reward',
    description: 'Creator referral — purchase',
    configKey: 'purchaseCoins',
  },
};

async function creditStage(input: {
  stage: CreatorReferralStage;
  creatorUserId: Types.ObjectId;
  referredUserId: Types.ObjectId;
  edgeId: Types.ObjectId;
}): Promise<boolean> {
  const cfg = await getOrCreateCreatorReferralConfig();
  if (!cfg.enabled) return false;

  const meta = STAGE_META[input.stage];
  const rewardCoins = cfg[meta.configKey];
  if (rewardCoins < 1) return false;

  const edge = await CreatorReferralEdge.findById(input.edgeId).lean();
  if (!edge) return false;
  if (isLegacyFullyPaid(edge)) return false;
  if (edge[meta.rewardedAtField]) return false;

  const txnId = creatorReferralStageTransactionId(
    input.stage,
    input.creatorUserId,
    input.referredUserId
  );

  const existingTxn = await CoinTransaction.findOne({ transactionId: txnId })
    .select('_id')
    .lean();
  if (existingTxn) {
    await CreatorReferralEdge.updateOne(
      { _id: edge._id, [meta.rewardedAtField]: null },
      {
        $set: {
          [meta.rewardedAtField]: new Date(),
          [meta.rewardCoinsField]: rewardCoins,
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
          [meta.rewardedAtField]: null,
        },
        {
          $set: {
            [meta.rewardedAtField]: new Date(),
            [meta.rewardCoinsField]: rewardCoins,
          },
        },
        { new: true, session }
      );
      if (!cas) return;

      try {
        await CoinTransaction.create(
          [
            {
              transactionId: txnId,
              userId: input.creatorUserId,
              type: 'credit',
              coins: rewardCoins,
              source: meta.source,
              description: `${meta.description} (${input.referredUserId.toString()})`,
              status: 'completed',
            },
          ],
          { session }
        );
      } catch (err) {
        if (isDuplicateKeyError(err)) return;
        throw err;
      }

      const updated = await User.findOneAndUpdate(
        { _id: input.creatorUserId },
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
    await emitCreatorCoinsUpdated(creatorFirebaseUid, input.creatorUserId, newBalance);
    verifyUserBalance(input.creatorUserId).catch((err) => {
      logError('creator referral balance integrity check failed', err as Error, {
        creatorUserId: input.creatorUserId.toString(),
        stage: input.stage,
      });
    });
    logInfo('Creator referral stage credited', {
      stage: input.stage,
      creatorUserId: input.creatorUserId.toString(),
      referredUserId: input.referredUserId.toString(),
      coins: rewardCoins,
      balance: newBalance,
    });
  }

  return credited;
}

export async function tryCreditAttach(
  creatorUserId: Types.ObjectId,
  referredUserId: Types.ObjectId
): Promise<boolean> {
  const edge = await CreatorReferralEdge.findOne({ creatorUserId, referredUserId })
    .select('_id')
    .lean();
  if (!edge) return false;
  return creditStage({
    stage: 'attach',
    creatorUserId,
    referredUserId,
    edgeId: edge._id,
  });
}

export async function tryCreditTelegram(
  creatorUserId: Types.ObjectId,
  referredUserId: Types.ObjectId
): Promise<boolean> {
  const edge = await CreatorReferralEdge.findOne({ creatorUserId, referredUserId })
    .select('_id telegramJoinedAt')
    .lean();
  if (!edge || !edge.telegramJoinedAt) return false;
  return creditStage({
    stage: 'telegram',
    creatorUserId,
    referredUserId,
    edgeId: edge._id,
  });
}

export async function tryCreditPurchase(referredUserId: Types.ObjectId): Promise<boolean> {
  const edge = await CreatorReferralEdge.findOne({ referredUserId })
    .select('_id creatorUserId')
    .lean();
  if (!edge) return false;
  return creditStage({
    stage: 'purchase',
    creatorUserId: edge.creatorUserId,
    referredUserId,
    edgeId: edge._id,
  });
}

/**
 * Create CreatorReferralEdge after a successful creator-code attach.
 * Pays attach stage immediately; backfills telegram and purchase stages if
 * the referred user already completed those actions.
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

  try {
    await CreatorReferralEdge.create({
      creatorUserId: input.creatorUserId,
      referredUserId: input.referredUserId,
      referralCodeUsed: input.referralCodeUsed,
      telegramJoinedAt,
      videoCallCompletedAt: null,
      creatorRewardedAt: null,
      creatorRewardCoins: null,
      attachRewardedAt: null,
      attachRewardCoins: null,
      telegramRewardedAt: null,
      telegramRewardCoins: null,
      purchaseRewardedAt: null,
      purchaseRewardCoins: null,
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

  await tryCreditAttach(input.creatorUserId, input.referredUserId);
  if (telegramJoinedAt) {
    await tryCreditTelegram(input.creatorUserId, input.referredUserId);
  }
  // Late attach: user may already have a qualifying purchase (wallet/VIP/Moments).
  if (await referredUserHasQualifyingPurchase(input.referredUserId)) {
    await tryCreditPurchase(input.referredUserId);
  }
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
      .select('creatorUserId telegramJoinedAt')
      .lean();
    if (!existing?.telegramJoinedAt) return;
    await tryCreditTelegram(existing.creatorUserId, referredUserId);
    return;
  }
  await tryCreditTelegram(edge.creatorUserId, referredUserId);
}

/** @deprecated Video call is no longer a payout stage. Kept as no-op for callers. */
export async function markCreatorReferralVideoCallCompleted(
  _referredUserId: Types.ObjectId
): Promise<void> {
  // no-op
}

export function onCreatorReferralTelegramClaimed(referredUserId: Types.ObjectId): void {
  void markCreatorReferralTelegramJoined(referredUserId).catch((err) => {
    logError('markCreatorReferralTelegramJoined failed', err as Error, {
      referredUserId: referredUserId.toString(),
    });
  });
}

/** @deprecated No-op; video call no longer pays creator referral. */
export function onCreatorReferralCallSettled(referredUserId: Types.ObjectId): void {
  void markCreatorReferralVideoCallCompleted(referredUserId).catch(() => {});
}

export function onCreatorReferralPurchase(referredUserId: Types.ObjectId): void {
  void tryCreditPurchase(referredUserId).catch((err) => {
    logError('tryCreditPurchase failed', err as Error, {
      referredUserId: referredUserId.toString(),
    });
  });
}

async function referredUserHasQualifyingPurchase(
  referredUserId: Types.ObjectId
): Promise<boolean> {
  const row = await CoinTransaction.findOne({
    userId: referredUserId,
    status: 'completed',
    type: 'credit',
    source: {
      $in: ['payment_gateway', 'vip_membership', 'moments_premium_membership'],
    },
  })
    .select('_id')
    .lean();
  return !!row;
}

/**
 * Re-attempt unpaid stages (e.g. after config re-enable).
 * Attach/telegram and purchase candidates are fetched separately so edges that
 * never purchased do not starve purchase backfill under the limit.
 */
export async function reconcileUnpaidCreatorReferrals(limit = 200): Promise<number> {
  const cfg = await getOrCreateCreatorReferralConfig();
  if (!cfg.enabled) return 0;

  const select =
    'creatorUserId referredUserId attachRewardedAt telegramJoinedAt telegramRewardedAt purchaseRewardedAt';

  const stageEdges = await CreatorReferralEdge.find({
    creatorRewardedAt: null,
    $or: [
      { attachRewardedAt: null },
      { telegramJoinedAt: { $ne: null }, telegramRewardedAt: null },
    ],
  })
    .select(select)
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  const purchaseEdges = await CreatorReferralEdge.find({
    creatorRewardedAt: null,
    purchaseRewardedAt: null,
  })
    .select(select)
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  const byId = new Map<string, (typeof stageEdges)[number]>();
  for (const row of stageEdges) byId.set(row._id.toString(), row);
  for (const row of purchaseEdges) {
    if (!byId.has(row._id.toString())) byId.set(row._id.toString(), row);
  }

  let paid = 0;
  for (const row of byId.values()) {
    if (!row.attachRewardedAt) {
      if (await tryCreditAttach(row.creatorUserId, row.referredUserId)) paid += 1;
    }
    if (row.telegramJoinedAt && !row.telegramRewardedAt) {
      if (await tryCreditTelegram(row.creatorUserId, row.referredUserId)) paid += 1;
    }
    if (!row.purchaseRewardedAt) {
      if (await referredUserHasQualifyingPurchase(row.referredUserId)) {
        if (await tryCreditPurchase(row.referredUserId)) paid += 1;
      }
    }
  }
  return paid;
}
