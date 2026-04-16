import { getRedis, callSessionKey } from '../../config/redis';

/**
 * When set (epoch ms), only sessions started at or after this time are in the "rollout cohort"
 * for optional behavior (e.g. backpressure delay skew). Unset = all calls eligible.
 */
export function getRolloutMinSessionStartMs(): number | null {
  const raw = process.env.BILLING_ROLLOUT_MIN_SESSION_START_MS;
  if (raw === undefined || raw === '') {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * True if env cohort is unset, or billing session startTime is at/after the rollout cutoff.
 */
export async function isCallInBillingRolloutCohort(callId: string): Promise<boolean> {
  const min = getRolloutMinSessionStartMs();
  if (min === null) {
    return true;
  }
  const redis = getRedis();
  const raw = await redis.get(callSessionKey(callId));
  if (!raw) {
    return true;
  }
  try {
    const s = JSON.parse(raw as string) as { startTime?: number };
    const st = Number(s.startTime);
    if (!Number.isFinite(st)) {
      return true;
    }
    return st >= min;
  } catch {
    return true;
  }
}
