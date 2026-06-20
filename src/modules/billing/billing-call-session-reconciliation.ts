import { Server } from 'socket.io';
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
import { BILLING_MAX_SETTLING_MS, isFailedSettlementAutoRecoveryEnabled } from './billing.constants';
import { enqueueImmediateSettlementRetry } from './billing-session-finalization.service';

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

export async function runCallSessionReconciliationPass(_io: Server): Promise<void> {
  if (!isDurableCallSessionEnabled()) return;

  const staleThreshold = new Date(Date.now() - BILLING_MAX_SETTLING_MS);
  const stale = await DurableCallSession.find({
    finalized: false,
    state: { $in: ['settling', 'ending'] },
    updatedAt: { $lt: staleThreshold },
  })
    .select('_id state')
    .limit(50)
    .lean();

  for (const row of stale) {
    await reconcileCallSessionDrift(row._id);
    if (row.state === 'settling') {
      await enqueueImmediateSettlementRetry({
        callId: row._id,
        reason: 'reconciliation',
        source: 'reconciliation_worker',
      });
      logInfo('call_session_reconciliation_finalize_enqueued', {
        callId: row._id,
        state: row.state,
      });
    } else {
      logInfo('call_session_reconciliation_checked', { callId: row._id, state: row.state });
    }
  }

  if (isFailedSettlementAutoRecoveryEnabled()) {
    const { attemptFailedSettlementRecovery } = await import('./billing-session-finalization.service');
    const failedRecoverable = await DurableCallSession.find({
      finalized: false,
      state: 'failed_settlement',
      billingSequence: { $gt: 0 },
    })
      .select('_id')
      .limit(20)
      .lean();

    for (const row of failedRecoverable) {
      await attemptFailedSettlementRecovery(row._id, 'reconciliation_worker');
    }
  }
}
