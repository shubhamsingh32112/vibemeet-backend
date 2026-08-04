/** Env-seeded defaults + process kill-switch for consumer rewards hub. */

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return fallback;
}

export function isConsumerRewardsMasterEnabled(): boolean {
  return parseBool(process.env.CONSUMER_REWARDS_ENABLED, true);
}

export function envRewardUploadProfilePhotoCoins(): number {
  return parsePositiveInt(process.env.REWARD_UPLOAD_PROFILE_PHOTO_COINS, 50);
}
export function envRewardCompleteProfileCoins(): number {
  return parsePositiveInt(process.env.REWARD_COMPLETE_PROFILE_COINS, 50);
}
export function envRewardFirstVideoCallCoins(): number {
  return parsePositiveInt(process.env.REWARD_FIRST_VIDEO_CALL_COINS, 1000);
}
export function envRewardFirstVideoCallMinSeconds(): number {
  return parsePositiveInt(process.env.REWARD_FIRST_VIDEO_CALL_MIN_SECONDS, 150);
}
export function envRewardFirstMessageCoins(): number {
  return parsePositiveInt(process.env.REWARD_FIRST_MESSAGE_COINS, 50);
}
export function envRewardInviteFriendCoins(): number {
  return parsePositiveInt(process.env.REWARD_INVITE_FRIEND_COINS, 100);
}
export function envRewardSuccessfulReferralCoins(): number {
  return parsePositiveInt(process.env.REWARD_SUCCESSFUL_REFERRAL_COINS, 500);
}
export function envRewardSuccessfulReferralMinPurchaseInr(): number {
  return parsePositiveInt(process.env.REWARD_SUCCESSFUL_REFERRAL_MIN_PURCHASE_INR, 100);
}
export function envRewardFirstRechargeCoins(): number {
  return parsePositiveInt(process.env.REWARD_FIRST_RECHARGE_COINS, 300);
}
export function envRewardWatchFreeMomentsCoins(): number {
  return parsePositiveInt(process.env.REWARD_WATCH_FREE_MOMENTS_COINS, 30);
}
export function envRewardWatchFreeMomentsTarget(): number {
  return parsePositiveInt(process.env.REWARD_WATCH_FREE_MOMENTS_TARGET, 5);
}
export function envRewardLikeMomentsCoins(): number {
  return parsePositiveInt(process.env.REWARD_LIKE_MOMENTS_COINS, 20);
}
export function envRewardLikeMomentsTarget(): number {
  return parsePositiveInt(process.env.REWARD_LIKE_MOMENTS_TARGET, 10);
}
export function envRewardFollowCreatorsCoins(): number {
  return parsePositiveInt(process.env.REWARD_FOLLOW_CREATORS_COINS, 50);
}
export function envRewardFollowCreatorsTarget(): number {
  return parsePositiveInt(process.env.REWARD_FOLLOW_CREATORS_TARGET, 5);
}

/** Daily unique id lists are hard-capped (anti-bloat). Targets never exceed this. */
export const DAILY_UNIQUE_IDS_CAP = 50;
export const FOLLOW_UNIQUE_IDS_CAP = 100;
