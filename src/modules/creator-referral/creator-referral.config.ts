/** Default creator referral stage coins (seeds Mongo singleton). */

export const CREATOR_REFERRAL_COINS_MAX = 10000;

function parseCoinsEnv(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), CREATOR_REFERRAL_COINS_MAX);
}

export function getCreatorReferralDefaultAttachCoins(): number {
  return parseCoinsEnv(process.env.CREATOR_REFERRAL_ATTACH_COINS, 200);
}

export function getCreatorReferralDefaultTelegramCoins(): number {
  return parseCoinsEnv(process.env.CREATOR_REFERRAL_TELEGRAM_COINS, 100);
}

export function getCreatorReferralDefaultPurchaseCoins(): number {
  return parseCoinsEnv(process.env.CREATOR_REFERRAL_PURCHASE_COINS, 1000);
}

/** @deprecated Prefer stage-specific defaults. Kept for env migration notes. */
export function getCreatorReferralDefaultCoins(): number {
  return parseCoinsEnv(process.env.CREATOR_REFERRAL_REWARD_COINS, 500);
}

export function getCreatorReferralDefaultEnabled(): boolean {
  const raw = process.env.CREATOR_REFERRAL_ENABLED;
  if (raw == null || raw === '') return true;
  return raw !== '0' && raw.toLowerCase() !== 'false';
}
