/** Default creator referral reward coins (seeds Mongo singleton). */
export function getCreatorReferralDefaultCoins(): number {
  const raw = process.env.CREATOR_REFERRAL_REWARD_COINS;
  const n = raw != null && raw !== '' ? Number(raw) : 500;
  if (!Number.isFinite(n) || n < 1) return 500;
  return Math.min(Math.floor(n), CREATOR_REFERRAL_COINS_MAX);
}

export function getCreatorReferralDefaultEnabled(): boolean {
  const raw = process.env.CREATOR_REFERRAL_ENABLED;
  if (raw == null || raw === '') return true;
  return raw !== '0' && raw.toLowerCase() !== 'false';
}

export const CREATOR_REFERRAL_COINS_MAX = 10000;
