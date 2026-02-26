import { featureFlags } from '../../config/feature-flags';
import {
  availabilityKey,
  getRedis,
  isRedisConfigured,
  sourceOfTruthLockKey,
  sourceOfTruthReportKey,
} from '../../config/redis';
import { Creator } from '../creator/creator.model';
import { User } from '../user/user.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { verifyUserBalance } from '../../utils/balance-integrity';
import { logger } from '../../utils/logger';

const RECONCILIATION_LOCK_TTL_SECONDS = 240;
const RECONCILIATION_REPORT_TTL_SECONDS = 24 * 60 * 60;

interface PresenceDrift {
  creatorId: string;
  creatorUserId: string;
  redisStatus: 'online' | 'busy';
  mongoIsOnline: boolean;
  repaired: boolean;
}

interface LedgerDrift {
  userId: string;
  role: string;
  actualBalance: number;
  expectedBalance: number;
  discrepancy: number;
  repaired: boolean;
}

export interface SourceOfTruthReport {
  timestamp: string;
  reason: string;
  authority: {
    presence: 'redis';
    callState: 'redis_active_session';
    coinLedger: 'coin_transaction_journal';
    projections: string[];
  };
  repairEnabled: boolean;
  presence: {
    checked: number;
    driftCount: number;
    drifts: PresenceDrift[];
  };
  billing: {
    checked: number;
    driftCount: number;
    drifts: LedgerDrift[];
  };
}

const comparePresenceAndRepair = async (): Promise<{
  checked: number;
  drifts: PresenceDrift[];
}> => {
  const creators = await Creator.find({})
    .select('_id userId isOnline')
    .lean();
  if (!isRedisConfigured() || creators.length === 0) {
    return { checked: creators.length, drifts: [] };
  }

  const redis = getRedis();
  const users = await User.find({ _id: { $in: creators.map((c) => c.userId) } })
    .select('_id firebaseUid')
    .lean();
  const userById = new Map(users.map((u) => [u._id.toString(), u]));

  const drifts: PresenceDrift[] = [];
  for (const creator of creators) {
    const owner = userById.get(creator.userId.toString());
    if (!owner?.firebaseUid) continue;

    const value = await redis.get<string>(availabilityKey(owner.firebaseUid));
    const redisStatus: 'online' | 'busy' = value === 'online' ? 'online' : 'busy';
    const expectedMongoIsOnline = redisStatus === 'online';
    if (creator.isOnline === expectedMongoIsOnline) continue;

    let repaired = false;
    if (featureFlags.sourceOfTruthReconciliationRepair) {
      await Creator.updateOne(
        { _id: creator._id },
        { $set: { isOnline: expectedMongoIsOnline } },
      );
      repaired = true;
    }

    drifts.push({
      creatorId: creator._id.toString(),
      creatorUserId: creator.userId.toString(),
      redisStatus,
      mongoIsOnline: creator.isOnline,
      repaired,
    });
  }

  return {
    checked: creators.length,
    drifts,
  };
};

const compareLedgerProjectionAndRepair = async (): Promise<{
  checked: number;
  drifts: LedgerDrift[];
}> => {
  const users = await User.find({})
    .select('_id role coins')
    .limit(300)
    .lean();

  const drifts: LedgerDrift[] = [];
  for (const user of users) {
    const check = await verifyUserBalance(user._id);
    if (!check.mismatch) continue;

    // Avoid repairing accounts that never wrote a ledger entry (legacy bootstrap balances).
    const txCount = await CoinTransaction.countDocuments({ userId: user._id, status: 'completed' });
    if (txCount === 0) continue;

    let repaired = false;
    if (featureFlags.sourceOfTruthReconciliationRepair) {
      await User.updateOne(
        { _id: user._id },
        { $set: { coins: Math.max(0, Math.floor(check.expectedBalance)) } },
      );
      repaired = true;
    }

    drifts.push({
      userId: user._id.toString(),
      role: user.role,
      actualBalance: check.actualBalance,
      expectedBalance: check.expectedBalance,
      discrepancy: check.discrepancy,
      repaired,
    });
  }

  return {
    checked: users.length,
    drifts,
  };
};

export const runSourceOfTruthReconciliation = async (reason = 'scheduled'): Promise<SourceOfTruthReport | null> => {
  if (!featureFlags.sourceOfTruthReconciliationEnabled) return null;
  if (!isRedisConfigured()) return null;

  const redis = getRedis();
  const lock = await redis.set(sourceOfTruthLockKey(), new Date().toISOString(), {
    nx: true,
    ex: RECONCILIATION_LOCK_TTL_SECONDS,
  });
  if (!lock) {
    logger.warn('sot.reconciliation.lock_conflict', { reason });
    return null;
  }

  try {
    const [presence, billing] = await Promise.all([
      comparePresenceAndRepair(),
      compareLedgerProjectionAndRepair(),
    ]);

    const report: SourceOfTruthReport = {
      timestamp: new Date().toISOString(),
      reason,
      authority: {
        presence: 'redis',
        callState: 'redis_active_session',
        coinLedger: 'coin_transaction_journal',
        projections: [
          'creator.isOnline (Mongo projection from Redis)',
          'user.coins (Mongo projection from ledger)',
          'socket events (projection only)',
          'stream channel activity messages (projection only)',
        ],
      },
      repairEnabled: featureFlags.sourceOfTruthReconciliationRepair,
      presence: {
        checked: presence.checked,
        driftCount: presence.drifts.length,
        drifts: presence.drifts.slice(0, 100),
      },
      billing: {
        checked: billing.checked,
        driftCount: billing.drifts.length,
        drifts: billing.drifts.slice(0, 100),
      },
    };

    await redis.set(sourceOfTruthReportKey(), JSON.stringify(report), {
      ex: RECONCILIATION_REPORT_TTL_SECONDS,
    });
    logger.info('sot.reconciliation.report', {
      reason,
      presenceDriftCount: report.presence.driftCount,
      billingDriftCount: report.billing.driftCount,
      repairEnabled: report.repairEnabled,
    });
    return report;
  } catch (error) {
    logger.error('sot.reconciliation.failed', { reason, error });
    return null;
  } finally {
    await redis.del(sourceOfTruthLockKey()).catch(() => {});
  }
};

export const getLatestSourceOfTruthReport = async (): Promise<SourceOfTruthReport | null> => {
  if (!isRedisConfigured()) return null;
  try {
    const redis = getRedis();
    const raw = await redis.get<string>(sourceOfTruthReportKey());
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : (raw as unknown as SourceOfTruthReport);
  } catch (error) {
    logger.warn('sot.reconciliation.read_report_failed', { error });
    return null;
  }
};

