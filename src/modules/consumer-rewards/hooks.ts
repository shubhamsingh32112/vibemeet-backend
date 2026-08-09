import mongoose from 'mongoose';
import { User } from '../user/user.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { istDateKey } from '../../utils/ist-time';
import type { MomentAccessReason } from '../moments/services/entitlement.service';
import {
  DAILY_UNIQUE_IDS_CAP,
  FOLLOW_UNIQUE_IDS_CAP,
} from './consumer-reward.config';
import { getOrCreateConsumerRewardConfig } from './consumer-reward-config.model';
import {
  ensureUserRewardProgress,
  getClaimedAt,
  UserRewardProgress,
} from './user-reward-progress.model';
import {
  creditDailyTaskReward,
  creditOnceTaskReward,
  safeRewardHook,
  type CreditResult,
} from './credit-reward.service';
import { TASK_REGISTRY } from './task-registry';
import {
  hasRewardQualifyingAvatar,
  isProfileCompleteForReward,
} from './profile-reward-eligibility';

/** Free-tier view reasons that count toward watch_free_moments (not paid unlocks). */
const FREE_VIEW_ACCESS_REASONS: ReadonlySet<MomentAccessReason> = new Set([
  'FREE',
  'PREVIEW',
  // VIP membership free access (no per-moment purchase)
  'VIP',
]);

export function isFreeTierMomentAccess(
  reason: MomentAccessReason | string | null | undefined
): boolean {
  if (!reason) return false;
  return FREE_VIEW_ACCESS_REASONS.has(reason as MomentAccessReason);
}

/**
 * Count completed payment_gateway credits (true purchases).
 * When `excludeTransactionId` is set, excludes that txn (optional).
 */
export async function countCompletedPaymentGatewayCredits(
  userId: mongoose.Types.ObjectId,
  excludeTransactionId?: string
): Promise<number> {
  const filter: Record<string, unknown> = {
    userId,
    source: 'payment_gateway',
    type: 'credit',
    status: 'completed',
  };
  if (excludeTransactionId) {
    filter.transactionId = { $ne: excludeTransactionId };
  }
  return CoinTransaction.countDocuments(filter);
}

export async function tryCreditProfilePhoto(
  userId: mongoose.Types.ObjectId
): Promise<CreditResult | null> {
  const cfg = await getOrCreateConsumerRewardConfig();
  if (!cfg.enabled || !cfg.tasks.upload_profile_photo.enabled) return null;
  const coins = cfg.tasks.upload_profile_photo.coins;
  if (coins < 1) return null;

  const user = await User.findById(userId).select(
    '_id role avatar username age gender'
  );
  if (
    !user ||
    user.role !== 'user' ||
    !hasRewardQualifyingAvatar(user)
  ) {
    return null;
  }

  const progress = await ensureUserRewardProgress(user._id);
  if (getClaimedAt(progress, 'upload_profile_photo')) {
    return { success: true, alreadyClaimed: true, coinsCredited: 0, balance: 0 };
  }

  return creditOnceTaskReward({
    userId: user._id,
    taskKey: 'upload_profile_photo',
    transactionId: `profile_photo_reward_${user._id}`,
    coins,
    source: 'profile_photo_reward',
    description: TASK_REGISTRY.upload_profile_photo.title,
  });
}

export async function tryCreditCompleteProfile(
  userId: mongoose.Types.ObjectId
): Promise<CreditResult | null> {
  const cfg = await getOrCreateConsumerRewardConfig();
  if (!cfg.enabled || !cfg.tasks.complete_profile.enabled) return null;
  const coins = cfg.tasks.complete_profile.coins;
  if (coins < 1) return null;

  const user = await User.findById(userId).select(
    '_id role avatar username age gender coins usernameChangeCount'
  );
  if (
    !user ||
    user.role !== 'user' ||
    !isProfileCompleteForReward(user)
  ) {
    return null;
  }

  const progress = await ensureUserRewardProgress(user._id);
  if (getClaimedAt(progress, 'complete_profile')) {
    return {
      success: true,
      alreadyClaimed: true,
      coinsCredited: 0,
      balance: user.coins ?? 0,
    };
  }

  return creditOnceTaskReward({
    userId: user._id,
    taskKey: 'complete_profile',
    transactionId: `profile_complete_reward_${user._id}`,
    coins,
    source: 'profile_complete_reward',
    description: TASK_REGISTRY.complete_profile.title,
  });
}

/** After profile/avatar mutation — credit photo then complete if eligible. */
export function onUserProfileMaybeUpdated(userId: mongoose.Types.ObjectId): void {
  safeRewardHook('profile_update', async () => {
    await tryCreditProfilePhoto(userId);
    await tryCreditCompleteProfile(userId);
  });
}

export async function tryCreditFirstMessage(
  userId: mongoose.Types.ObjectId
): Promise<CreditResult | null> {
  const cfg = await getOrCreateConsumerRewardConfig();
  if (!cfg.enabled || !cfg.tasks.first_message.enabled) return null;
  const coins = cfg.tasks.first_message.coins;
  if (coins < 1) return null;

  const user = await User.findById(userId).select('_id role');
  if (!user || user.role !== 'user') return null;

  const progress = await ensureUserRewardProgress(user._id);
  if (getClaimedAt(progress, 'first_message')) return null;

  return creditOnceTaskReward({
    userId: user._id,
    taskKey: 'first_message',
    transactionId: `first_message_reward_${user._id}`,
    coins,
    source: 'first_message_reward',
    description: TASK_REGISTRY.first_message.title,
  });
}

export function onUserSentMessage(userId: mongoose.Types.ObjectId): void {
  safeRewardHook('first_message', async () => {
    await tryCreditFirstMessage(userId);
  });
}

export async function tryCreditFirstVideoCall(
  userId: mongoose.Types.ObjectId,
  durationSeconds: number
): Promise<CreditResult | null> {
  const cfg = await getOrCreateConsumerRewardConfig();
  if (!cfg.enabled || !cfg.tasks.first_video_call.enabled) return null;
  const minSec = cfg.tasks.first_video_call.minSeconds ?? 150;
  if (durationSeconds < minSec) return null;
  const coins = cfg.tasks.first_video_call.coins;
  if (coins < 1) return null;

  const user = await User.findById(userId).select('_id role');
  if (!user || user.role !== 'user') return null;

  const progress = await ensureUserRewardProgress(user._id);
  if (getClaimedAt(progress, 'first_video_call')) return null;

  return creditOnceTaskReward({
    userId: user._id,
    taskKey: 'first_video_call',
    transactionId: `first_video_call_reward_${user._id}`,
    coins,
    source: 'first_video_call_reward',
    description: TASK_REGISTRY.first_video_call.title,
  });
}

export function onUserCallSettled(
  userId: mongoose.Types.ObjectId,
  durationSeconds: number
): void {
  safeRewardHook('first_video_call', async () => {
    await tryCreditFirstVideoCall(userId, durationSeconds);
    await tryCreditSuccessfulReferralOnCall(userId, durationSeconds);
  });
  // Creator affiliate: any settled call with duration > 0 (no min-seconds gate).
  if (durationSeconds > 0) {
    void import('../creator-referral/creator-referral-reward.service')
      .then(({ onCreatorReferralCallSettled }) => {
        onCreatorReferralCallSettled(userId);
      })
      .catch(() => {
        // non-fatal
      });
  }
}

/**
 * True first purchase only: exactly one completed gateway credit for user
 * (the current verify just wrote it). Legacy rechargers on next buy → no bonus.
 */
export async function tryCreditFirstRecharge(
  userId: mongoose.Types.ObjectId
): Promise<CreditResult | null> {
  const cfg = await getOrCreateConsumerRewardConfig();
  if (!cfg.enabled || !cfg.tasks.first_recharge.enabled) return null;
  const coins = cfg.tasks.first_recharge.coins;
  if (coins < 1) return null;

  const user = await User.findById(userId).select('_id role');
  if (!user || user.role !== 'user') return null;

  const gatewayCount = await countCompletedPaymentGatewayCredits(user._id);
  if (gatewayCount !== 1) return null;

  const progress = await ensureUserRewardProgress(user._id);
  if (getClaimedAt(progress, 'first_recharge')) return null;

  return creditOnceTaskReward({
    userId: user._id,
    taskKey: 'first_recharge',
    transactionId: `first_recharge_reward_${user._id}`,
    coins,
    source: 'first_recharge_reward',
    description: TASK_REGISTRY.first_recharge.title,
  });
}

export function onUserFirstRecharge(userId: mongoose.Types.ObjectId): void {
  safeRewardHook('first_recharge', async () => {
    await tryCreditFirstRecharge(userId);
  });
}

export async function tryCreditInviteFriend(
  referrerId: mongoose.Types.ObjectId,
  referredUserId: mongoose.Types.ObjectId
): Promise<CreditResult | null> {
  const cfg = await getOrCreateConsumerRewardConfig();
  if (!cfg.enabled || !cfg.tasks.invite_friend.enabled) return null;
  const coins = cfg.tasks.invite_friend.coins;
  if (coins < 1) return null;

  const referrer = await User.findById(referrerId).select('_id role');
  if (!referrer || referrer.role !== 'user') return null;

  const progressKey = `invite_friend_${referredUserId.toString()}`;
  const progress = await ensureUserRewardProgress(referrer._id);
  if (getClaimedAt(progress, progressKey)) return null;

  return creditOnceTaskReward({
    userId: referrer._id,
    taskKey: 'invite_friend',
    progressClaimKey: progressKey,
    transactionId: `invite_friend_reward_${referrer._id}_${referredUserId}`,
    coins,
    source: 'invite_friend_reward',
    description: `Invite friend reward (${referredUserId.toString()})`,
  });
}

export function onReferralAttached(
  referrerId: mongoose.Types.ObjectId,
  referredUserId: mongoose.Types.ObjectId
): void {
  safeRewardHook('invite_friend', async () => {
    await tryCreditInviteFriend(referrerId, referredUserId);
  });
}

/**
 * Successful referral amount from Mongo config (default 500).
 */
export async function getSuccessfulReferralConfig(): Promise<{
  enabled: boolean;
  coins: number;
  minPurchaseInr: number;
}> {
  const cfg = await getOrCreateConsumerRewardConfig();
  const t = cfg.tasks.successful_referral;
  return {
    enabled: cfg.enabled && t.enabled,
    coins: t.coins,
    minPurchaseInr: t.minPurchaseInr ?? 100,
  };
}

/**
 * Call-path successful referral. Shares `referral_reward_{referrer}_{referred}`
 * and `rewardGranted` with purchase path so wallet $inc + ledger row happen once.
 */
export async function tryCreditSuccessfulReferralOnCall(
  referredUserId: mongoose.Types.ObjectId,
  durationSeconds: number
): Promise<void> {
  const cfg = await getOrCreateConsumerRewardConfig();
  if (!cfg.enabled || !cfg.tasks.successful_referral.enabled) return;
  const minSec = cfg.tasks.first_video_call.minSeconds ?? 150;
  if (durationSeconds < minSec) return;

  const coins = cfg.tasks.successful_referral.coins;
  if (coins < 1) return;

  const referred = await User.findById(referredUserId)
    .select('_id role referredBy')
    .lean();
  if (!referred?.referredBy) return;

  const referrerId = referred.referredBy as mongoose.Types.ObjectId;
  const referrer = await User.findById(referrerId).select('_id role');
  if (!referrer || referrer.role !== 'user') return;

  const txnId = `referral_reward_${referrerId}_${referredUserId}`;
  // Already granted via purchase path (wallet + ledger exists).
  const existingTxn = await CoinTransaction.findOne({ transactionId: txnId })
    .select('_id')
    .lean();
  if (existingTxn) return;

  const grant = await User.updateOne(
    {
      _id: referrerId,
      referrals: {
        $elemMatch: { user: referredUserId, rewardGranted: false },
      },
    },
    {
      $set: { 'referrals.$[r].rewardGranted': true },
    },
    {
      arrayFilters: [{ 'r.user': referredUserId, 'r.rewardGranted': false }],
    }
  );
  if (grant.modifiedCount !== 1) return;

  const progressKey = `successful_referral_${referredUserId.toString()}`;
  await creditOnceTaskReward({
    userId: referrerId,
    taskKey: 'successful_referral',
    progressClaimKey: progressKey,
    transactionId: txnId,
    coins,
    source: 'referral_reward',
    description: `Successful referral (qualified call by ${referredUserId})`,
  });
}

/** Reset IST daily bucket when dateKey differs, then $addToSet moment id. */
async function atomicAddDailyMomentId(
  userId: mongoose.Types.ObjectId,
  field: 'viewedMomentIds' | 'likedMomentIds',
  momentId: string,
  todayKey: string
): Promise<{ count: number; claimed: boolean }> {
  await ensureUserRewardProgress(userId);

  await UserRewardProgress.updateOne(
    { userId, 'daily.dateKey': { $ne: todayKey } },
    {
      $set: {
        daily: {
          dateKey: todayKey,
          viewedMomentIds: [],
          likedMomentIds: [],
          watchClaimed: false,
          likeClaimed: false,
        },
      },
    }
  );

  const path = `daily.${field}` as const;
  await UserRewardProgress.updateOne(
    {
      userId,
      'daily.dateKey': todayKey,
      $expr: { $lt: [{ $size: `$${path}` }, DAILY_UNIQUE_IDS_CAP] },
    },
    { $addToSet: { [path]: momentId } }
  );

  const progress = await UserRewardProgress.findOne({ userId }).lean();
  const daily = progress?.daily;
  if (!daily || daily.dateKey !== todayKey) {
    return { count: 0, claimed: false };
  }
  const ids =
    field === 'viewedMomentIds' ? daily.viewedMomentIds : daily.likedMomentIds;
  const claimed =
    field === 'viewedMomentIds' ? Boolean(daily.watchClaimed) : Boolean(daily.likeClaimed);
  return { count: ids?.length ?? 0, claimed };
}

export async function recordMomentViewForReward(
  userId: mongoose.Types.ObjectId,
  momentId: string,
  accessReason?: MomentAccessReason | string | null
): Promise<void> {
  if (!isFreeTierMomentAccess(accessReason)) return;

  const cfg = await getOrCreateConsumerRewardConfig();
  if (!cfg.enabled || !cfg.tasks.watch_free_moments.enabled) return;

  const user = await User.findById(userId).select('_id role');
  if (!user || user.role !== 'user') return;

  const todayKey = istDateKey(new Date());
  const { count, claimed } = await atomicAddDailyMomentId(
    user._id,
    'viewedMomentIds',
    momentId,
    todayKey
  );

  const target = cfg.tasks.watch_free_moments.targetCount ?? 5;
  if (count >= target && !claimed) {
    await tryCreditWatchOrLikeDaily(user._id, 'watch_free_moments');
  }
}

export async function recordMomentLikeForReward(
  userId: mongoose.Types.ObjectId,
  momentId: string
): Promise<void> {
  const cfg = await getOrCreateConsumerRewardConfig();
  if (!cfg.enabled || !cfg.tasks.like_moments.enabled) return;

  const user = await User.findById(userId).select('_id role');
  if (!user || user.role !== 'user') return;

  const todayKey = istDateKey(new Date());
  const { count, claimed } = await atomicAddDailyMomentId(
    user._id,
    'likedMomentIds',
    momentId,
    todayKey
  );

  const target = cfg.tasks.like_moments.targetCount ?? 10;
  if (count >= target && !claimed) {
    await tryCreditWatchOrLikeDaily(user._id, 'like_moments');
  }
}

export function onMomentViewed(
  userId: mongoose.Types.ObjectId,
  momentId: string,
  accessReason?: MomentAccessReason | string | null
): void {
  safeRewardHook('moment_view', async () => {
    await recordMomentViewForReward(userId, momentId, accessReason);
  });
}

export function onMomentLiked(
  userId: mongoose.Types.ObjectId,
  momentId: string
): void {
  safeRewardHook('moment_like', async () => {
    await recordMomentLikeForReward(userId, momentId);
  });
}

export async function recordCreatorFollowForReward(
  userId: mongoose.Types.ObjectId,
  creatorUserId: string
): Promise<void> {
  const cfg = await getOrCreateConsumerRewardConfig();
  if (!cfg.enabled || !cfg.tasks.follow_creators.enabled) return;

  const user = await User.findById(userId).select('_id role');
  if (!user || user.role !== 'user') return;

  await ensureUserRewardProgress(user._id);

  const progress = await UserRewardProgress.findOne({ userId: user._id });
  if (!progress) return;
  if (getClaimedAt(progress, 'follow_creators')) return;

  await UserRewardProgress.updateOne(
    {
      userId: user._id,
      $expr: {
        $lt: [{ $size: '$lifetime.followedCreatorIds' }, FOLLOW_UNIQUE_IDS_CAP],
      },
    },
    { $addToSet: { 'lifetime.followedCreatorIds': creatorUserId } }
  );

  const refreshed = await UserRewardProgress.findOne({ userId: user._id }).lean();
  const followed = refreshed?.lifetime?.followedCreatorIds?.length ?? 0;
  const target = cfg.tasks.follow_creators.targetCount ?? 5;
  if (followed >= target) {
    await tryCreditFollowCreators(user._id);
  }
}

export function onCreatorFollowed(
  userId: mongoose.Types.ObjectId,
  creatorUserId: string
): void {
  safeRewardHook('follow_creators', async () => {
    await recordCreatorFollowForReward(userId, creatorUserId);
  });
}

export async function tryCreditFollowCreators(
  userId: mongoose.Types.ObjectId
): Promise<CreditResult | null> {
  const cfg = await getOrCreateConsumerRewardConfig();
  if (!cfg.enabled || !cfg.tasks.follow_creators.enabled) return null;
  const coins = cfg.tasks.follow_creators.coins;
  const target = cfg.tasks.follow_creators.targetCount ?? 5;
  if (coins < 1) return null;

  const progress = await ensureUserRewardProgress(userId);
  if (getClaimedAt(progress, 'follow_creators')) {
    return { success: true, alreadyClaimed: true, coinsCredited: 0, balance: 0 };
  }
  if (progress.lifetime.followedCreatorIds.length < target) return null;

  return creditOnceTaskReward({
    userId,
    taskKey: 'follow_creators',
    transactionId: `follow_creators_reward_${userId}`,
    coins,
    source: 'follow_creators_reward',
    description: TASK_REGISTRY.follow_creators.title,
  });
}

export async function tryCreditWatchOrLikeDaily(
  userId: mongoose.Types.ObjectId,
  taskKey: 'watch_free_moments' | 'like_moments'
): Promise<CreditResult | null> {
  const cfg = await getOrCreateConsumerRewardConfig();
  if (!cfg.enabled) return null;
  const slice =
    taskKey === 'watch_free_moments'
      ? cfg.tasks.watch_free_moments
      : cfg.tasks.like_moments;
  if (!slice.enabled || slice.coins < 1) return null;

  const todayKey = istDateKey(new Date());
  const progress = await ensureUserRewardProgress(userId);
  if (progress.daily.dateKey !== todayKey) return null;

  const current =
    taskKey === 'watch_free_moments'
      ? progress.daily.viewedMomentIds.length
      : progress.daily.likedMomentIds.length;
  const target = slice.targetCount ?? (taskKey === 'watch_free_moments' ? 5 : 10);
  const claimedFlag =
    taskKey === 'watch_free_moments'
      ? progress.daily.watchClaimed
      : progress.daily.likeClaimed;
  if (claimedFlag || current < target) return null;

  const source =
    taskKey === 'watch_free_moments'
      ? 'moment_watch_daily_reward'
      : 'moment_like_daily_reward';
  const txn =
    taskKey === 'watch_free_moments'
      ? `moment_watch_daily_reward_${userId}_${todayKey}`
      : `moment_like_daily_reward_${userId}_${todayKey}`;

  return creditDailyTaskReward({
    userId,
    taskKey,
    dateKey: todayKey,
    transactionId: txn,
    coins: slice.coins,
    source,
    description: TASK_REGISTRY[taskKey].title,
  });
}

// test helpers
export const __test = {
  hasRewardQualifyingAvatar,
  isProfileCompleteForReward,
  isFreeTierMomentAccess,
};
