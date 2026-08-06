import { User } from '../user/user.model';
import { istDateKey } from '../../utils/ist-time';
import { getTelegramRewardStatus } from '../telegram-reward/telegram-reward.service';
import {
  getOrCreateConsumerRewardConfig,
  type ConsumerRewardConfigView,
} from './consumer-reward-config.model';
import {
  ensureUserRewardProgress,
  getClaimedAt,
  type IUserRewardProgress,
} from './user-reward-progress.model';
import { TASK_REGISTRY } from './task-registry';
import {
  CONSUMER_REWARD_TASK_KEYS,
  type ConsumerRewardTaskKey,
} from './task-keys';
import {
  ConsumerRewardError,
} from './credit-reward.service';
import {
  tryCreditCompleteProfile,
  tryCreditFollowCreators,
  tryCreditProfilePhoto,
  tryCreditWatchOrLikeDaily,
} from './hooks';
import {
  hasRewardQualifyingAvatar,
  isProfileCompleteForReward,
} from './profile-reward-eligibility';

export type HubTaskItem = {
  key: ConsumerRewardTaskKey;
  title: string;
  description: string;
  coins: number;
  cadence: string;
  status: 'locked' | 'available' | 'in_progress' | 'claimable' | 'claimed' | 'disabled';
  progress?: { current: number; target: number };
  claimed: boolean;
  claimable: boolean;
  cta: { type: string; value: string };
};

export type HubPayload = {
  enabled: boolean;
  coinsBalance: number;
  tasks: HubTaskItem[];
};

function ensureDailyBucket(
  progress: IUserRewardProgress,
  todayKey: string
): IUserRewardProgress {
  if (progress.daily.dateKey !== todayKey) {
    progress.daily = {
      dateKey: todayKey,
      viewedMomentIds: [],
      likedMomentIds: [],
      watchClaimed: false,
      likeClaimed: false,
    };
  }
  return progress;
}

export async function getRewardsHubForUser(input: {
  firebaseUid: string;
}): Promise<HubPayload> {
  const cfg = await getOrCreateConsumerRewardConfig();
  const user = await User.findOne({ firebaseUid: input.firebaseUid }).select(
    '_id role coins username age gender avatar firebaseUid usernameChangeCount'
  );
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

  if (!cfg.enabled) {
    return { enabled: false, coinsBalance: user.coins ?? 0, tasks: [] };
  }

  const progress = await ensureUserRewardProgress(user._id);
  const todayKey = istDateKey(new Date());
  ensureDailyBucket(progress, todayKey);

  let telegram: {
    enabled: boolean;
    claimed: boolean;
    linked: boolean;
    rewardCoins: number;
  } | null = null;
  try {
    const tg = await getTelegramRewardStatus({ firebaseUid: input.firebaseUid });
    telegram = {
      enabled: tg.enabled,
      claimed: tg.claimed,
      linked: tg.linked,
      rewardCoins: tg.rewardCoins,
    };
  } catch {
    telegram = null;
  }

  const tasks: HubTaskItem[] = [];

  for (const key of CONSUMER_REWARD_TASK_KEYS) {
    const meta = TASK_REGISTRY[key];
    if (key === 'telegram_join') {
      const claimed = Boolean(telegram?.claimed);
      const enabled = Boolean(telegram?.enabled);
      tasks.push({
        key,
        title: meta.title,
        description: meta.description,
        coins: telegram?.rewardCoins ?? 100,
        cadence: meta.cadence,
        status: !enabled
          ? 'disabled'
          : claimed
            ? 'claimed'
            : telegram?.linked
              ? 'claimable'
              : 'available',
        claimed,
        claimable: enabled && !claimed,
        cta: meta.cta,
      });
      continue;
    }

    const slice = cfg.tasks[key as keyof ConsumerRewardConfigView['tasks']];
    if (!slice) continue;

    if (key === 'invite_friend' || key === 'successful_referral') {
      // Per-referral info only (no single claim) — show as available progress tip
      tasks.push({
        key,
        title: meta.title,
        description: meta.description,
        coins: slice.coins,
        cadence: meta.cadence,
        status: slice.enabled ? 'available' : 'disabled',
        claimed: false,
        claimable: false,
        cta: meta.cta,
      });
      continue;
    }

    if (!slice.enabled) {
      tasks.push({
        key,
        title: meta.title,
        description: meta.description,
        coins: slice.coins,
        cadence: meta.cadence,
        status: 'disabled',
        claimed: false,
        claimable: false,
        cta: meta.cta,
      });
      continue;
    }

    if (key === 'watch_free_moments' || key === 'like_moments') {
      const target = slice.targetCount ?? 5;
      const current =
        key === 'watch_free_moments'
          ? progress.daily.viewedMomentIds.length
          : progress.daily.likedMomentIds.length;
      const claimed =
        key === 'watch_free_moments'
          ? progress.daily.watchClaimed
          : progress.daily.likeClaimed;
      const reached = current >= target;
      tasks.push({
        key,
        title: meta.title,
        description: meta.description,
        coins: slice.coins,
        cadence: meta.cadence,
        status: claimed
          ? 'claimed'
          : reached
            ? 'claimable'
            : current > 0
              ? 'in_progress'
              : 'available',
        progress: { current: Math.min(current, target), target },
        claimed,
        claimable: !claimed && reached,
        cta: meta.cta,
      });
      continue;
    }

    if (key === 'follow_creators') {
      const target = slice.targetCount ?? 5;
      const current = progress.lifetime.followedCreatorIds.length;
      const claimed = Boolean(getClaimedAt(progress, key));
      tasks.push({
        key,
        title: meta.title,
        description: meta.description,
        coins: slice.coins,
        cadence: meta.cadence,
        status: claimed
          ? 'claimed'
          : current >= target
            ? 'claimable'
            : current > 0
              ? 'in_progress'
              : 'available',
        progress: { current: Math.min(current, target), target },
        claimed,
        claimable: !claimed && current >= target,
        cta: meta.cta,
      });
      continue;
    }

    // once tasks
    const claimed = Boolean(getClaimedAt(progress, key));
    let eligible = false;
    if (key === 'upload_profile_photo') {
      eligible = hasRewardQualifyingAvatar(user);
    } else if (key === 'complete_profile') {
      eligible = isProfileCompleteForReward(user);
    } else {
      // first_* only claimable after event via auto credit; hub shows claimed/not
      eligible = false;
    }

    tasks.push({
      key,
      title: meta.title,
      description: meta.description,
      coins: slice.coins,
      cadence: meta.cadence,
      status: claimed
        ? 'claimed'
        : eligible
          ? 'claimable'
          : 'available',
      claimed,
      // follow/watch/like already handled above; only photo/profile are claimable here
      claimable: !claimed && eligible,
      cta: meta.cta,
    });
  }

  return {
    enabled: true,
    coinsBalance: user.coins ?? 0,
    tasks,
  };
}

function requireCreditResult(
  result: CreditResultCompat | null,
  message: string
): CreditResultCompat {
  if (result) return result;
  // Do NOT return alreadyClaimed — that masked ineligible claims as success.
  throw new ConsumerRewardError(message, 400, 'NOT_ELIGIBLE');
}

export async function claimRewardsTask(input: {
  firebaseUid: string;
  taskKey: string;
}): Promise<CreditResultCompat> {
  const user = await User.findOne({ firebaseUid: input.firebaseUid }).select(
    '_id role coins username age gender avatar usernameChangeCount'
  );
  if (!user) throw new ConsumerRewardError('User not found', 404);
  if (user.role !== 'user') {
    throw new ConsumerRewardError('Rewards only available for users', 403, 'ROLE');
  }

  const key = input.taskKey as ConsumerRewardTaskKey;

  switch (key) {
    case 'upload_profile_photo':
      return requireCreditResult(
        await tryCreditProfilePhoto(user._id),
        'Upload your own profile photo first (default avatars do not qualify)'
      );
    case 'complete_profile':
      return requireCreditResult(
        await tryCreditCompleteProfile(user._id),
        'Complete your profile: custom photo, username, age, and gender'
      );
    case 'follow_creators':
      return requireCreditResult(
        await tryCreditFollowCreators(user._id),
        'Follow the required number of creators first'
      );
    case 'watch_free_moments':
    case 'like_moments':
      return requireCreditResult(
        await tryCreditWatchOrLikeDaily(user._id, key),
        'Complete the daily progress target first'
      );
    case 'first_video_call':
    case 'first_message':
    case 'first_recharge':
      // Auto-only; re-check if somehow eligible (no-op for claim without domain context)
      throw new ConsumerRewardError(
        'This reward is credited automatically when the goal is met',
        400,
        'AUTO_ONLY'
      );
    case 'telegram_join':
      throw new ConsumerRewardError(
        'Use Telegram Verify to claim this reward',
        400,
        'USE_TELEGRAM'
      );
    case 'invite_friend':
    case 'successful_referral':
      throw new ConsumerRewardError(
        'Referral rewards credit automatically',
        400,
        'AUTO_ONLY'
      );
    default:
      throw new ConsumerRewardError('Unknown task', 400, 'UNKNOWN');
  }
}

type CreditResultCompat = {
  success: true;
  alreadyClaimed: boolean;
  coinsCredited: number;
  balance: number;
};

// re-export helpers used by claim path only
export { ConsumerRewardError };
