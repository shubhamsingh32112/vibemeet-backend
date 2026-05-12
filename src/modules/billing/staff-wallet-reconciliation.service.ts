import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { StaffWalletLedger } from './staff-wallet-ledger.model';
import { StaffWalletReconciliationLog } from './staff-wallet-reconciliation-log.model';
import { User } from '../user/user.model';
import { logInfo, logWarning } from '../../utils/logger';

export type ReconcileStaffBalanceOptions = {
  runId: string;
  dryRun?: boolean;
  startedAt: Date;
};

export type ReconcileStaffBalanceResult = {
  staffUserId: string;
  expectedBalance: number;
  actualBalance: number;
  driftAmount: number;
  autoCorrected: boolean;
  correctionAmount: number;
};

/** In-memory summary for health / worker endpoints */
export type StaffWalletReconciliationSummary = {
  runId: string;
  startedAt: string;
  completedAt: string;
  processed: number;
  driftCount: number;
  maxAbsDrift: number;
  errors: number;
};

let lastStaffWalletReconciliationSummary: StaffWalletReconciliationSummary | null = null;

export function getLastStaffWalletReconciliationSummary(): StaffWalletReconciliationSummary | null {
  return lastStaffWalletReconciliationSummary;
}

function readEnvBool(key: string, defaultVal: boolean): boolean {
  const v = process.env[key]?.trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return defaultVal;
}

function readEnvInt(key: string, fallback: number): number {
  const n = parseInt(process.env[key]?.trim() ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export function isStaffWalletReconcileAutoFixEnabled(): boolean {
  return readEnvBool('STAFF_WALLET_RECONCILE_AUTO_FIX', false);
}

export function getStaffWalletReconcileToleranceCoins(): number {
  return Math.max(0, readEnvInt('STAFF_WALLET_RECONCILE_TOLERANCE_COINS', 0));
}

/**
 * Authoritative balance from immutable ledger: sum(credits) − sum(debits).
 */
export async function recomputeBalanceFromLedger(
  staffUserId: mongoose.Types.ObjectId | string
): Promise<number> {
  const oid =
    typeof staffUserId === 'string'
      ? new mongoose.Types.ObjectId(staffUserId)
      : staffUserId;

  const agg = await StaffWalletLedger.aggregate<{ creditSum: number; debitSum: number }>([
    { $match: { staffUserId: oid } },
    {
      $group: {
        _id: null,
        creditSum: {
          $sum: {
            $cond: [{ $eq: ['$direction', 'credit'] }, '$amountCoins', 0],
          },
        },
        debitSum: {
          $sum: {
            $cond: [{ $eq: ['$direction', 'debit'] }, '$amountCoins', 0],
          },
        },
      },
    },
  ]);

  if (!agg.length) return 0;
  return (agg[0].creditSum ?? 0) - (agg[0].debitSum ?? 0);
}

/**
 * Compare cached User.staffCoinsBalance to ledger-derived balance; optionally auto-correct.
 */
export async function reconcileStaffBalance(
  staffUserId: mongoose.Types.ObjectId | string,
  options: ReconcileStaffBalanceOptions
): Promise<ReconcileStaffBalanceResult> {
  const oid =
    typeof staffUserId === 'string'
      ? new mongoose.Types.ObjectId(staffUserId)
      : staffUserId;

  const expectedBalance = await recomputeBalanceFromLedger(oid);
  const user = await User.findById(oid).select('staffCoinsBalance').lean();
  const actualBalance =
    typeof user?.staffCoinsBalance === 'number' ? user.staffCoinsBalance : 0;

  const driftAmount = actualBalance - expectedBalance;
  const tolerance = getStaffWalletReconcileToleranceCoins();
  const absDrift = Math.abs(driftAmount);
  let autoCorrected = false;
  let correctionAmount = 0;

  const needsFix =
    absDrift > tolerance && isStaffWalletReconcileAutoFixEnabled() && !options.dryRun;

  if (needsFix) {
    correctionAmount = expectedBalance - actualBalance;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        /** Ledger sum is authoritative; adjust cached field only so we do not double-count ledger rows. */
        await User.updateOne(
          { _id: oid },
          { $set: { staffCoinsBalance: Math.max(0, expectedBalance) } },
          { session }
        );
      });
      autoCorrected = true;
    } finally {
      await session.endSession();
    }
  }

  if (absDrift > tolerance) {
    logWarning('Staff wallet reconciliation drift', {
      staffUserId: oid.toString(),
      expectedBalance,
      actualBalance,
      driftAmount,
      dryRun: options.dryRun ?? false,
      autoCorrected,
    });
  }

  const completedAt = new Date();
  await StaffWalletReconciliationLog.create({
    runId: options.runId,
    staffUserId: oid,
    expectedBalance,
    actualBalance,
    driftAmount,
    autoCorrected,
    correctionAmount: autoCorrected ? correctionAmount : 0,
    startedAt: options.startedAt,
    completedAt,
    metadata: {
      dryRun: options.dryRun ?? false,
      tolerance,
      autoFixWouldApply:
        absDrift > tolerance && isStaffWalletReconcileAutoFixEnabled() && !options.dryRun,
    },
  });

  return {
    staffUserId: oid.toString(),
    expectedBalance,
    actualBalance,
    driftAmount,
    autoCorrected,
    correctionAmount: autoCorrected ? correctionAmount : 0,
  };
}

export type ReconcileAllOptions = {
  dryRun?: boolean;
  batchSize?: number;
};

/**
 * All distinct staff users seen in ledger plus any user document with staffCoinsBalance set.
 */
export async function collectStaffUserIdsForReconciliation(): Promise<mongoose.Types.ObjectId[]> {
  const fromLedger = await StaffWalletLedger.distinct('staffUserId');
  const ledgerIds = (fromLedger as mongoose.Types.ObjectId[]).filter(Boolean);

  const balanceUsers = await User.find({
    staffCoinsBalance: { $exists: true, $ne: null },
  })
    .select('_id')
    .lean();

  const set = new Set<string>();
  for (const id of ledgerIds) set.add(id.toString());
  for (const u of balanceUsers) set.add(u._id.toString());

  return [...set].map((s) => new mongoose.Types.ObjectId(s));
}

export async function reconcileAllStaffBalances(
  options?: ReconcileAllOptions
): Promise<StaffWalletReconciliationSummary> {
  const runId = randomUUID();
  const startedAt = new Date();
  const batchSize = Math.min(
    500,
    Math.max(10, options?.batchSize ?? readEnvInt('STAFF_WALLET_RECONCILE_BATCH_SIZE', 200))
  );

  const ids = await collectStaffUserIdsForReconciliation();
  let processed = 0;
  let driftCount = 0;
  let maxAbsDrift = 0;
  let errors = 0;
  const tolerance = getStaffWalletReconcileToleranceCoins();

  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);
    for (const oid of chunk) {
      try {
        const r = await reconcileStaffBalance(oid, {
          runId,
          dryRun: options?.dryRun,
          startedAt,
        });
        processed++;
        if (Math.abs(r.driftAmount) > tolerance) driftCount++;
        maxAbsDrift = Math.max(maxAbsDrift, Math.abs(r.driftAmount));
      } catch {
        errors++;
      }
    }
  }

  const completedAt = new Date();
  const summary: StaffWalletReconciliationSummary = {
    runId,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    processed,
    driftCount,
    maxAbsDrift,
    errors,
  };
  lastStaffWalletReconciliationSummary = summary;

  logInfo('Staff wallet reconciliation batch completed', {
    runId,
    processed,
    driftCount,
    maxAbsDrift,
    errors,
    dryRun: options?.dryRun ?? false,
  });

  return summary;
}
