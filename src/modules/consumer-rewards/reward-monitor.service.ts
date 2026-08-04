import { CoinTransaction } from '../user/coin-transaction.model';
import {
  addIstDays,
  istDateKey,
  istDayBounds,
} from '../../utils/ist-time';
import { getRewardIssuanceToday } from './reward-metrics';
import { REWARD_LEDGER_SOURCES } from './reward-metrics';
import { getOrCreateConsumerRewardConfig } from './consumer-reward-config.model';

export type RewardsMonitorRange = 'today' | '7d';

export type RewardsMonitorPayload = {
  range: RewardsMonitorRange;
  dateFrom: string;
  dateTo: string;
  coinsIssued: number;
  redisIssuanceToday: number;
  dailyBudget: number;
  budgetMode: string;
  budgetUtilizationPct: number;
  topEarners: Array<{ userId: string; coins: number }>;
  countsBySource: Record<string, { count: number; coins: number }>;
  topReferrers: Array<{ userId: string; coins: number; count: number }>;
  softAlerts: string[];
};

function rangeBounds(range: RewardsMonitorRange, now = new Date()): {
  dateFrom: string;
  dateTo: string;
  start: Date;
  end: Date;
} {
  const dateTo = istDateKey(now);
  if (range === 'today') {
    const { start, end } = istDayBounds(dateTo);
    return { dateFrom: dateTo, dateTo, start, end };
  }
  const dateFrom = addIstDays(dateTo, -6);
  const start = istDayBounds(dateFrom).start;
  const end = istDayBounds(dateTo).end;
  return { dateFrom, dateTo, start, end };
}

/**
 * Fraud / issuance monitoring (read-only aggregations).
 */
export async function getRewardsMonitor(
  range: RewardsMonitorRange = 'today',
  now = new Date()
): Promise<RewardsMonitorPayload> {
  const { dateFrom, dateTo, start, end } = rangeBounds(range, now);
  const cfg = await getOrCreateConsumerRewardConfig();

  const bySource = await CoinTransaction.aggregate([
    {
      $match: {
        type: 'credit',
        status: 'completed',
        source: { $in: [...REWARD_LEDGER_SOURCES] },
        createdAt: { $gte: start, $lt: end },
      },
    },
    {
      $group: {
        _id: '$source',
        count: { $sum: 1 },
        coins: { $sum: '$coins' },
      },
    },
  ]);

  const countsBySource: Record<string, { count: number; coins: number }> = {};
  let coinsIssued = 0;
  for (const row of bySource) {
    const source = String(row._id);
    const count = Number(row.count) || 0;
    const coins = Number(row.coins) || 0;
    countsBySource[source] = { count, coins };
    coinsIssued += coins;
  }

  const topEarnersAgg = await CoinTransaction.aggregate([
    {
      $match: {
        type: 'credit',
        status: 'completed',
        source: { $in: [...REWARD_LEDGER_SOURCES] },
        createdAt: { $gte: start, $lt: end },
      },
    },
    {
      $group: {
        _id: '$userId',
        coins: { $sum: '$coins' },
      },
    },
    { $sort: { coins: -1 } },
    { $limit: 25 },
  ]);

  const topEarners = topEarnersAgg.map((r) => ({
    userId: String(r._id),
    coins: Number(r.coins) || 0,
  }));

  const referrerAgg = await CoinTransaction.aggregate([
    {
      $match: {
        type: 'credit',
        status: 'completed',
        source: { $in: ['referral_reward', 'invite_friend_reward'] },
        createdAt: { $gte: start, $lt: end },
      },
    },
    {
      $group: {
        _id: '$userId',
        coins: { $sum: '$coins' },
        count: { $sum: 1 },
      },
    },
    { $sort: { coins: -1 } },
    { $limit: 25 },
  ]);

  const topReferrers = referrerAgg.map((r) => ({
    userId: String(r._id),
    coins: Number(r.coins) || 0,
    count: Number(r.count) || 0,
  }));

  const redisIssuanceToday = await getRewardIssuanceToday();
  const dailyBudget = cfg.dailyRewardBudgetCoins ?? 500_000;
  const budgetUtilizationPct =
    dailyBudget > 0
      ? Math.round(((redisIssuanceToday || coinsIssued) / dailyBudget) * 1000) / 10
      : 0;

  const softAlerts: string[] = [];
  const tgCount = countsBySource.telegram_join_reward?.count ?? 0;
  if (tgCount > 2000) {
    softAlerts.push(`telegram claims high: ${tgCount}`);
  }
  if (topEarners[0] && topEarners[0].coins > 50_000) {
    softAlerts.push(
      `top earner ${topEarners[0].userId} received ${topEarners[0].coins} coins in range`
    );
  }
  if (budgetUtilizationPct >= 100) {
    softAlerts.push(
      `daily budget utilization ${budgetUtilizationPct}% (budget ${dailyBudget})`
    );
  }

  return {
    range,
    dateFrom,
    dateTo,
    coinsIssued,
    redisIssuanceToday,
    dailyBudget,
    budgetMode: cfg.dailyBudgetMode ?? 'alert_only',
    budgetUtilizationPct,
    topEarners,
    countsBySource,
    topReferrers,
    softAlerts,
  };
}
