import { DurableCallSession } from './call-session.model';
import { sumLedgerForCall } from './billing-ledger.model';
import {
  isDurableCallSessionEnabled,
  isIncrementalBillingPersistEnabled,
} from './billing-phase-flags';
import { recordDualWriteDrift, recordReconciliationDrift } from './billing-phase-metrics';
import { getRedis, callSessionKey } from '../../config/redis';
import { logInfo, logWarning } from '../../utils/logger';
import type { CallSession as RedisCallSession } from './billing.service';

export async function reconcileCallSessionDrift(callId: string): Promise<boolean> {
  if (!isDurableCallSessionEnabled()) return true;

  const mongo = await DurableCallSession.findById(callId).lean();
  if (!mongo) return true;

  const redisRaw = await getRedis().get(callSessionKey(callId));
  if (redisRaw) {
    const redisSession = JSON.parse(redisRaw) as RedisCallSession;
    const deductDrift = Math.abs(
      (mongo.totalUserDebitedMicros || 0) - (redisSession.totalDeductedMicros || 0)
    );
    const earnDrift = Math.abs(
      (mongo.totalCreatorCreditedMicros || 0) - (redisSession.totalEarnedMicros || 0)
    );
    if (deductDrift > 0) {
      recordDualWriteDrift(callId, 'totalUserDebitedMicros', deductDrift);
    }
    if (earnDrift > 0) {
      recordDualWriteDrift(callId, 'totalCreatorCreditedMicros', earnDrift);
    }
    if (deductDrift > 1_000_000 || earnDrift > 1_000_000) {
      logWarning('call_session_dual_write_drift', { callId, deductDrift, earnDrift });
      return false;
    }
  }

  if (isIncrementalBillingPersistEnabled()) {
    const ledgerSum = await sumLedgerForCall(callId);
    const ledgerUserDrift = Math.abs(
      (mongo.totalUserDebitedMicros || 0) - ledgerSum.userDebitMicros
    );
    const ledgerCreatorDrift = Math.abs(
      (mongo.totalCreatorCreditedMicros || 0) - ledgerSum.creatorCreditMicros
    );
    if (ledgerUserDrift > 0 || ledgerCreatorDrift > 0) {
      recordReconciliationDrift(callId, 'ledger_vs_session');
      logWarning('billing_ledger_session_drift', {
        callId,
        ledgerUserDrift,
        ledgerCreatorDrift,
      });
      return false;
    }
  }

  return true;
}

export async function runCallSessionReconciliationPass(): Promise<void> {
  if (!isDurableCallSessionEnabled()) return;

  const stale = await DurableCallSession.find({
    finalized: false,
    state: { $in: ['settling', 'ending'] },
    updatedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) },
  })
    .select('_id state')
    .limit(50)
    .lean();

  for (const row of stale) {
    await reconcileCallSessionDrift(row._id);
    logInfo('call_session_reconciliation_checked', { callId: row._id, state: row.state });
  }
}
