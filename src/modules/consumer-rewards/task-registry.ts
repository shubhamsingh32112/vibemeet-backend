import type { ConsumerRewardTaskKey } from './task-keys';
import type {
  CoinTransactionSourceForReward,
  ConsumerRewardCadence,
} from './task-keys';
import {
  envRewardCompleteProfileCoins,
  envRewardFirstMessageCoins,
  envRewardFirstRechargeCoins,
  envRewardFirstVideoCallCoins,
  envRewardFirstVideoCallMinSeconds,
  envRewardFollowCreatorsCoins,
  envRewardFollowCreatorsTarget,
  envRewardInviteFriendCoins,
  envRewardLikeMomentsCoins,
  envRewardLikeMomentsTarget,
  envRewardSuccessfulReferralCoins,
  envRewardSuccessfulReferralMinPurchaseInr,
  envRewardUploadProfilePhotoCoins,
  envRewardWatchFreeMomentsCoins,
  envRewardWatchFreeMomentsTarget,
} from './consumer-reward.config';

export type TaskMeta = {
  key: ConsumerRewardTaskKey;
  title: string;
  description: string;
  cadence: ConsumerRewardCadence;
  source: CoinTransactionSourceForReward | null; // null for telegram (external module)
  claimMode: 'manual' | 'auto' | 'external';
  cta: { type: 'route' | 'action'; value: string };
};

export const TASK_REGISTRY: Record<ConsumerRewardTaskKey, TaskMeta> = {
  telegram_join: {
    key: 'telegram_join',
    title: 'Join MatchVibe Telegram',
    description: 'Join our official Telegram channel and verify membership.',
    cadence: 'once',
    source: null,
    claimMode: 'external',
    cta: { type: 'action', value: 'telegram_sheet' },
  },
  upload_profile_photo: {
    key: 'upload_profile_photo',
    title: 'Upload Profile Photo',
    description: 'Add a profile photo to earn coins.',
    cadence: 'once',
    source: 'profile_photo_reward',
    claimMode: 'auto',
    cta: { type: 'route', value: '/edit-profile' },
  },
  complete_profile: {
    key: 'complete_profile',
    title: 'Complete Profile',
    description: 'Add photo, name, age, and gender.',
    cadence: 'once',
    source: 'profile_complete_reward',
    claimMode: 'auto',
    cta: { type: 'route', value: '/edit-profile' },
  },
  first_video_call: {
    key: 'first_video_call',
    title: 'Complete First Video Call',
    description: 'Stay on a video call for a few minutes.',
    cadence: 'once',
    source: 'first_video_call_reward',
    claimMode: 'auto',
    cta: { type: 'route', value: '/home' },
  },
  first_message: {
    key: 'first_message',
    title: 'Send First Message',
    description: 'Send your first message to a creator.',
    cadence: 'once',
    source: 'first_message_reward',
    claimMode: 'auto',
    cta: { type: 'route', value: '/chat' },
  },
  invite_friend: {
    key: 'invite_friend',
    title: 'Invite a Friend',
    description: 'Friend installs and registers with your code.',
    cadence: 'per_referral',
    source: 'invite_friend_reward',
    claimMode: 'auto',
    cta: { type: 'route', value: '/referral' },
  },
  successful_referral: {
    key: 'successful_referral',
    title: 'Successful Referral',
    description: 'Referred friend recharges or completes a qualified call.',
    cadence: 'per_referral',
    source: 'referral_reward',
    claimMode: 'auto',
    cta: { type: 'route', value: '/referral' },
  },
  first_recharge: {
    key: 'first_recharge',
    title: 'Recharge for the First Time',
    description: 'Complete your first coin purchase.',
    cadence: 'once',
    source: 'first_recharge_reward',
    claimMode: 'auto',
    cta: { type: 'route', value: '/wallet' },
  },
  watch_free_moments: {
    key: 'watch_free_moments',
    title: 'Watch Free Moments',
    description: 'Watch free Moments today.',
    cadence: 'daily',
    source: 'moment_watch_daily_reward',
    claimMode: 'auto',
    cta: { type: 'route', value: '/moments' },
  },
  like_moments: {
    key: 'like_moments',
    title: 'Like Moments',
    description: 'Like Moments today.',
    cadence: 'daily',
    source: 'moment_like_daily_reward',
    claimMode: 'auto',
    cta: { type: 'route', value: '/moments' },
  },
  follow_creators: {
    key: 'follow_creators',
    title: 'Follow Creators',
    description: 'Follow creators to unlock a one-time bonus.',
    cadence: 'once',
    source: 'follow_creators_reward',
    claimMode: 'auto',
    cta: { type: 'route', value: '/home' },
  },
};

export function buildDefaultTaskConfig() {
  return {
    upload_profile_photo: {
      enabled: true,
      coins: envRewardUploadProfilePhotoCoins(),
    },
    complete_profile: {
      enabled: true,
      coins: envRewardCompleteProfileCoins(),
    },
    first_video_call: {
      enabled: true,
      coins: envRewardFirstVideoCallCoins(),
      minSeconds: envRewardFirstVideoCallMinSeconds(),
    },
    first_message: {
      enabled: true,
      coins: envRewardFirstMessageCoins(),
    },
    invite_friend: {
      enabled: true,
      coins: envRewardInviteFriendCoins(),
    },
    successful_referral: {
      enabled: true,
      coins: envRewardSuccessfulReferralCoins(),
      minPurchaseInr: envRewardSuccessfulReferralMinPurchaseInr(),
    },
    first_recharge: {
      enabled: true,
      coins: envRewardFirstRechargeCoins(),
    },
    watch_free_moments: {
      enabled: true,
      coins: envRewardWatchFreeMomentsCoins(),
      targetCount: envRewardWatchFreeMomentsTarget(),
    },
    like_moments: {
      enabled: true,
      coins: envRewardLikeMomentsCoins(),
      targetCount: envRewardLikeMomentsTarget(),
    },
    follow_creators: {
      enabled: true,
      coins: envRewardFollowCreatorsCoins(),
      targetCount: envRewardFollowCreatorsTarget(),
    },
  };
}
