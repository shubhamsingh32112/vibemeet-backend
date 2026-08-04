import { monitoring } from '../../utils/monitoring';
import { logError, logWarning } from '../../utils/logger';
import { getRedis, isRedisConfigured } from '../../config/redis';
import { istDateKey } from '../../utils/ist-time';
import { getOrCreateConsumerRewardConfig } from './consumer-reward-config.model';

/** Sources used by recon + fraud monitor (includes check-in). */
export const REWARD_LEDGER_SOURCES = [
  'telegram_join_reward',
  'profile_photo_reward',
  'profile_complete_reward',
  'first_video_call_reward',
  'first_message_reward',
  'invite_friend_reward',
  'referral_reward',
  'first_recharge_reward',
  'moment_watch_daily_reward',
  'moment_like_daily_reward',
  'follow_creators_reward',
  'daily_checkin',
] as const;

export type RewardLedgerSource = (typeof REWARD_LEDGER_SOURCES)[number];

export function recordRewardMetric(
  name: string,
  value = 1,
  tags?: Record<string, string>
): void {
  try {
    monitoring.recordMetric(`reward.${name}`, value, tags);
  } catch {
    // never throw from metrics
  }
}

export function recordRewardCreditSuccess(taskKey: string, coins: number): void {
  recordRewardMetric('credit_success', 1, { taskKey });
  recordRewardMetric('credit_coins', coins, { taskKey });
}

export function recordRewardCreditAlready(taskKey: string): void {
  recordRewardMetric('credit_already', 1, { taskKey });
}

export function recordRewardCreditFail(taskKey: string, code: string): void {
  recordRewardMetric('credit_fail', 1, { taskKey, code });
}

function budgetCounterKey(dateKey: string): string {
  return `reward_coins_issued:${dateKey}`;
}

/**
 * Soft daily budget: alert when exceeded; does not block credits (alert_only).
 */
export async function trackRewardIssuance(coins: number): Promise<void> {
  if (!Number.isFinite(coins) || coins <= 0) return;
  const dateKey = istDateKey(new Date());
  let total = 0;

  try {
    if (isRedisConfigured()) {
      const redis = getRedis();
      total = await redis.incrby(budgetCounterKey(dateKey), Math.floor(coins));
      await redis.expire(budgetCounterKey(dateKey), 2 * 24 * 60 * 60);
    }
  } catch (err) {
    logWarning('reward budget redis incr failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const cfg = await getOrCreateConsumerRewardConfig();
    const budget = cfg.dailyRewardBudgetCoins ?? 500_000;
    if (total > 0 && total >= budget) {
      recordRewardMetric('budget_exceeded', 1, {
        dateKey,
        mode: cfg.dailyBudgetMode ?? 'alert_only',
      });
      logError('Reward daily budget exceeded (alert_only — credits not blocked)', new Error('budget_exceeded'), {
        dateKey,
        total,
        budget,
        mode: cfg.dailyBudgetMode ?? 'alert_only',
      });
    }
  } catch {
    // ignore config read failures
  }
}

export async function getRewardIssuanceToday(): Promise<number> {
  const dateKey = istDateKey(new Date());
  try {
    if (!isRedisConfigured()) return 0;
    const raw = await getRedis().get(budgetCounterKey(dateKey));
    return raw ? parseInt(raw, 10) || 0 : 0;
  } catch {
    return 0;
  }
}
