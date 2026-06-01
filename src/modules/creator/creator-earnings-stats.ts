import { CREATOR_SHARE_PERCENTAGE } from '../../config/pricing.config';

/** Matches creator dashboard / wallet all-time and task minute aggregations. */
export const CREATOR_BILLABLE_CALL_MATCH = {
  durationSeconds: { $gt: 0 },
} as const;

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Current rate shown to creators as `earningsPerMinute` (price × share). */
export function expectedCreatorEarningsPerMinute(pricePerMinute: number): number {
  return round2(pricePerMinute * CREATOR_SHARE_PERCENTAGE);
}

/** Historical average shown to creators as `avgEarningsPerMinute`. */
export function computeAvgEarningsPerMinute(
  totalEarned: number,
  totalDurationSec: number
): number {
  const minutes = totalDurationSec / 60;
  if (minutes <= 0) return 0;
  return round2(totalEarned / minutes);
}

/**
 * Deviation of historical avg vs current expected rate (not vs full user price).
 * Small values are normal (ceil billing, old prices); large negative values flag issues.
 */
export function computeEarnDeviationPct(
  avgEarningsPerMinute: number,
  expectedEarningsPerMinute: number
): number {
  if (expectedEarningsPerMinute <= 0 || avgEarningsPerMinute <= 0) return 0;
  return round2(
    ((avgEarningsPerMinute - expectedEarningsPerMinute) / expectedEarningsPerMinute) * 100
  );
}
