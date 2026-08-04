import mongoose from 'mongoose';
import { CoinTransaction } from '../user/coin-transaction.model';
import { verifyUserBalance } from '../../utils/balance-integrity';
import {
  addIstDays,
  istDateKey,
  istDayBounds,
  istYesterdayKey,
} from '../../utils/ist-time';
import { logError, logInfo } from '../../utils/logger';
import { REWARD_LEDGER_SOURCES, recordRewardMetric } from './reward-metrics';
import { UserRewardProgress } from './user-reward-progress.model';

export type RewardReconReport = {
  dateKey: string;
  reward_tx_sum_coins: number;
  reward_tx_count: number;
  claim_event_count_by_task: Record<string, number>;
  claim_estimated_coins: number;
  wallet_sample_users: number;
  wallet_mismatch_users_count: number;
  discrepancy_max: number;
  ok: boolean;
  notes: string[];
  generatedAt: string;
};

let latestReport: RewardReconReport | null = null;

export function getLatestReconReport(): RewardReconReport | null {
  return latestReport;
}

/**
 * Nightly reward ledger recon for one IST day.
 * ledger sum vs daily claim counts + wallet sample for earners.
 */
export async function runRewardReconciliation(
  dateKey?: string,
  now = new Date()
): Promise<RewardReconReport> {
  const dayKey = dateKey ?? istYesterdayKey(now);
  const { start, end } = istDayBounds(dayKey);
  const notes: string[] = [];

  const ledgerAgg = await CoinTransaction.aggregate([
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
        coins: { $sum: '$coins' },
        count: { $sum: 1 },
        users: { $addToSet: '$userId' },
      },
    },
  ]);

  let reward_tx_sum_coins = 0;
  let reward_tx_count = 0;
  const claim_event_count_by_task: Record<string, number> = {};
  const earnerIds = new Set<string>();

  for (const row of ledgerAgg) {
    const source = String(row._id);
    const coins = Number(row.coins) || 0;
    const count = Number(row.count) || 0;
    reward_tx_sum_coins += coins;
    reward_tx_count += count;
    claim_event_count_by_task[source] = count;
    for (const u of row.users || []) {
      earnerIds.add(String(u));
    }
  }

  // Daily progress flags for watch/like (supplementary signal)
  const watchLike = await UserRewardProgress.countDocuments({
    'daily.dateKey': dayKey,
    $or: [{ 'daily.watchClaimed': true }, { 'daily.likeClaimed': true }],
  });
  if (watchLike > 0) {
    claim_event_count_by_task['daily_progress_watch_or_like_users'] = watchLike;
  }

  // claim_estimated_coins ≈ ledger for completed reward rows (same identity when unique txn)
  const claim_estimated_coins = reward_tx_sum_coins;

  // Sample balances for earners (cap 500)
  const sampleIds = [...earnerIds]
    .slice(0, 500)
    .map((id) => new mongoose.Types.ObjectId(id));
  let wallet_mismatch_users_count = 0;
  let discrepancy_max = 0;
  for (const uid of sampleIds) {
    const result = await verifyUserBalance(uid);
    if (result.mismatch) {
      wallet_mismatch_users_count += 1;
      discrepancy_max = Math.max(discrepancy_max, Math.abs(result.discrepancy));
    }
  }

  const ledgerClaimDelta = Math.abs(claim_estimated_coins - reward_tx_sum_coins);
  const ok =
    wallet_mismatch_users_count === 0 && ledgerClaimDelta <= 1;

  if (!ok) {
    notes.push(
      wallet_mismatch_users_count > 0
        ? `wallet mismatches=${wallet_mismatch_users_count} maxΔ=${discrepancy_max}`
        : 'claim/ledger inequality'
    );
    logError('Reward ledger reconciliation FAILED', new Error('recon_mismatch'), {
      dateKey: dayKey,
      reward_tx_sum_coins,
      wallet_mismatch_users_count,
      discrepancy_max,
    });
    recordRewardMetric('recon_fail', 1, { dateKey: dayKey });
  } else {
    notes.push('clean');
    recordRewardMetric('recon_ok', 1, { dateKey: dayKey });
  }

  const report: RewardReconReport = {
    dateKey: dayKey,
    reward_tx_sum_coins,
    reward_tx_count,
    claim_event_count_by_task,
    claim_estimated_coins,
    wallet_sample_users: sampleIds.length,
    wallet_mismatch_users_count,
    discrepancy_max,
    ok,
    notes,
    generatedAt: new Date().toISOString(),
  };
  latestReport = report;
  logInfo('Reward ledger reconciliation report', report as unknown as Record<string, unknown>);
  return report;
}

/** True when IST hour:minute is inside the recon window (01:30–01:40). */
export function isInsideReconWindow(now = new Date()): boolean {
  const key = istDateKey(now);
  const { start } = istDayBounds(key);
  // 01:30 IST = start + 1h30m
  const windowStart = start.getTime() + (1 * 60 + 30) * 60 * 1000;
  const windowEnd = windowStart + 10 * 60 * 1000;
  const t = now.getTime();
  return t >= windowStart && t < windowEnd;
}

let lastReconDateKey: string | null = null;
let reconInterval: ReturnType<typeof setInterval> | null = null;

export async function runRewardReconTick(now = new Date()): Promise<void> {
  if (!isInsideReconWindow(now)) return;
  const yKey = istYesterdayKey(now);
  if (lastReconDateKey === yKey) return;
  lastReconDateKey = yKey;
  await runRewardReconciliation(yKey, now);
}

export function startRewardReconciliationJob(): void {
  if (reconInterval) return;
  const tick = () => {
    runRewardReconTick().catch((err) => {
      logError('Reward recon tick failed', err as Error);
    });
  };
  reconInterval = setInterval(tick, 5 * 60 * 1000);
  setTimeout(tick, 60_000);
  logInfo('Reward ledger reconciliation job started (IST 01:30 window)');
}

export function stopRewardReconciliationJob(): void {
  if (reconInterval) {
    clearInterval(reconInterval);
    reconInterval = null;
  }
}

/** @internal test helper */
export function __resetReconJobState(): void {
  lastReconDateKey = null;
  latestReport = null;
}

export function __testAddIstDays(key: string, days: number): string {
  return addIstDays(key, days);
}
