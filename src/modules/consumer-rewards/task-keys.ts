export const CONSUMER_REWARD_TASK_KEYS = [
  'telegram_join',
  'upload_profile_photo',
  'complete_profile',
  'first_video_call',
  'first_message',
  'invite_friend',
  'successful_referral',
  'first_recharge',
  'watch_free_moments',
  'like_moments',
  'follow_creators',
] as const;

export type ConsumerRewardTaskKey = (typeof CONSUMER_REWARD_TASK_KEYS)[number];

export type ConsumerRewardCadence = 'once' | 'daily' | 'per_referral';

export type CoinTransactionSourceForReward =
  | 'telegram_join_reward'
  | 'profile_photo_reward'
  | 'profile_complete_reward'
  | 'first_video_call_reward'
  | 'first_message_reward'
  | 'invite_friend_reward'
  | 'referral_reward'
  | 'first_recharge_reward'
  | 'moment_watch_daily_reward'
  | 'moment_like_daily_reward'
  | 'follow_creators_reward';

export function isConsumerRewardTaskKey(v: string): v is ConsumerRewardTaskKey {
  return (CONSUMER_REWARD_TASK_KEYS as readonly string[]).includes(v);
}
