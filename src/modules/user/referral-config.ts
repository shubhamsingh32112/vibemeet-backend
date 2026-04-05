/**
 * Referral program tuning via environment (defaults match previous constants).
 */

const DEFAULT_REWARD_COINS = 60;
const DEFAULT_MIN_PURCHASE_INR = 100;
const DEFAULT_ATTACH_WINDOW_MS = 24 * 60 * 60 * 1000;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getReferralRewardCoins(): number {
  return parsePositiveInt(process.env.REFERRAL_REWARD_COINS, DEFAULT_REWARD_COINS);
}

export function getReferralMinPurchaseInr(): number {
  return parsePositiveInt(process.env.REFERRAL_MIN_PURCHASE_INR, DEFAULT_MIN_PURCHASE_INR);
}

export function getReferralAttachWindowMs(): number {
  return parsePositiveInt(process.env.REFERRAL_ATTACH_WINDOW_MS, DEFAULT_ATTACH_WINDOW_MS);
}
