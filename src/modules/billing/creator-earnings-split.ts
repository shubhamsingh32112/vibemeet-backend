/**
 * Split creator call earnings into paid (user wallet) vs free (intro/promo) portions.
 *
 * Prorates by user debit micros recorded at settlement.
 */
export function splitCreatorEarningsByDebit(
  totalEarnedCreator: number,
  introDeductedMicros: number,
  walletDeductedMicros: number
): { paidCoinsEarned: number; freeCoinsEarned: number } {
  const total = Math.max(0, Math.floor(Number(totalEarnedCreator) || 0));
  const intro = Math.max(0, Number(introDeductedMicros) || 0);
  const wallet = Math.max(0, Number(walletDeductedMicros) || 0);
  const debit = intro + wallet;

  if (total <= 0) {
    return { paidCoinsEarned: 0, freeCoinsEarned: 0 };
  }

  // No intro debit (or unknown debit) → treat all earnings as paid.
  if (debit <= 0 || wallet >= debit) {
    return { paidCoinsEarned: total, freeCoinsEarned: 0 };
  }

  if (wallet <= 0) {
    return { paidCoinsEarned: 0, freeCoinsEarned: total };
  }

  const paidCoinsEarned = Math.round(total * (wallet / debit));
  const freeCoinsEarned = total - paidCoinsEarned;
  return { paidCoinsEarned, freeCoinsEarned };
}

/** Mongo expression: paid coins with legacy fallback (missing split → all paid). */
export const PAID_COINS_EARNED_EXPR = {
  $ifNull: ['$paidCoinsEarned', '$coinsEarned'],
} as const;

/** Mongo expression: free coins with legacy fallback (missing split → 0). */
export const FREE_COINS_EARNED_EXPR = {
  $ifNull: ['$freeCoinsEarned', 0],
} as const;
