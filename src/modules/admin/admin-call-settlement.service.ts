/**
 * Admin tooling to preview and retry failed call settlements.
 */

import { Server } from 'socket.io';
import { Call } from '../video/call.model';
import { CallHistory } from '../billing/call-history.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import {
  getRedis,
  callSessionKey,
  billingRecoveryDeadLetterKey,
  settledCallKey,
} from '../../config/redis';
import {
  resolveAuthoritativeSettlementTotals,
  type AuthoritativeSettlementTotals,
} from '../billing/billing-settlement-totals.service';
import {
  attemptFailedSettlementRecovery,
  enqueueImmediateSettlementRetry,
  isCallBillingAlreadySettled,
} from '../billing/billing-session-finalization.service';
import {
  getDurableCallSession,
  resetDurableCallSessionForSettlementRetry,
} from '../billing/call-session.service';
import { microsToUserDebitWholeCoins } from '../billing/billing.constants';
import { isDurableCallSessionEnabled } from '../billing/billing-phase-flags';
import { logInfo } from '../../utils/logger';

export type SettlementIssue =
  | 'zero_duration_with_billing'
  | 'unsettled_ledger'
  | 'failed_recovery'
  | 'stuck_settling'
  | null;

export interface SettlementRetryPreview {
  callId: string;
  eligible: boolean;
  skipReason?: string;
  settlementIssue: SettlementIssue;
  billingStatus: string;
  callHistory: {
    durationSeconds: number;
    coinsDeducted: number;
    coinsEarned: number;
    settlementStatus?: string;
  } | null;
  authoritativeTotals: AuthoritativeSettlementTotals;
  authoritativeCoinsDeducted: number;
  proposedDurationSeconds: number;
  proposedCoinsDeducted: number;
  deadLetterPresent: boolean;
  hasVideoCallDebitTxn: boolean;
}

export function computeSettlementIssue(
  userCall: {
    durationSeconds: number;
    coinsDeducted: number;
    settlementStatus?: string;
  } | null,
  totals: AuthoritativeSettlementTotals,
  billingStatus: string,
  hasVideoCallDebitTxn: boolean
): SettlementIssue {
  if (billingStatus === 'failed_recovery_settlement') {
    return 'failed_recovery';
  }
  if (billingStatus === 'settling') {
    return 'stuck_settling';
  }
  if (
    userCall &&
    userCall.durationSeconds === 0 &&
    (totals.billingSequence > 0 || totals.totalDeductedMicros > 0)
  ) {
    return 'zero_duration_with_billing';
  }
  if (userCall && userCall.coinsDeducted > 0 && !hasVideoCallDebitTxn) {
    return 'unsettled_ledger';
  }
  return null;
}

export interface SettlementListMeta {
  totals: AuthoritativeSettlementTotals;
  hasVideoCallDebitTxn: boolean;
  settlementIssue: SettlementIssue;
  authoritativeCoinsDeducted: number;
  canRetrySettlement: boolean;
}

export async function batchBuildSettlementListMeta(
  items: Array<{
    callId: string;
    userCall: {
      durationSeconds: number;
      coinsDeducted: number;
      settlementStatus?: string;
    };
    billingStatus: string;
  }>
): Promise<Map<string, SettlementListMeta>> {
  const result = new Map<string, SettlementListMeta>();
  if (items.length === 0) {
    return result;
  }

  const callIds = items.map((item) => item.callId);
  const [totalsList, debitTxns] = await Promise.all([
    Promise.all(callIds.map((callId) => resolveAuthoritativeSettlementTotals(callId))),
    CoinTransaction.find({
      callId: { $in: callIds },
      type: 'debit',
      source: 'video_call',
    })
      .select('callId')
      .lean(),
  ]);

  const debitTxnCallIds = new Set(debitTxns.map((txn) => txn.callId));

  items.forEach((item, index) => {
    const totals = totalsList[index];
    const hasVideoCallDebitTxn = debitTxnCallIds.has(item.callId);
    const settlementIssue = computeSettlementIssue(
      item.userCall,
      totals,
      item.billingStatus,
      hasVideoCallDebitTxn
    );
    result.set(item.callId, {
      totals,
      hasVideoCallDebitTxn,
      settlementIssue,
      authoritativeCoinsDeducted: microsToUserDebitWholeCoins(totals.totalDeductedMicros),
      canRetrySettlement: settlementIssue != null,
    });
  });

  return result;
}

export async function buildSettlementRetryPreview(callId: string): Promise<SettlementRetryPreview> {
  const [userCall, callDoc, totals, deadLetterRaw, debitTxn] = await Promise.all([
    CallHistory.findOne({ callId, ownerRole: 'user' })
      .select('durationSeconds coinsDeducted coinsEarned settlementStatus')
      .lean(),
    Call.findOne({ callId }).select('settlement.status').lean(),
    resolveAuthoritativeSettlementTotals(callId),
    getRedis().get(billingRecoveryDeadLetterKey(callId)),
    CoinTransaction.findOne({ callId, type: 'debit', source: 'video_call' }).select('_id').lean(),
  ]);

  const billingStatus = callDoc?.settlement?.status ?? 'unknown';
  const hasVideoCallDebitTxn = Boolean(debitTxn);
  const settlementIssue = computeSettlementIssue(
    userCall,
    totals,
    billingStatus,
    hasVideoCallDebitTxn
  );

  const pricePerSecondMicros =
    totals.totalDeductedMicros > 0 && totals.billingSequence > 0
      ? Math.floor(totals.totalDeductedMicros / Math.max(1, totals.billingSequence))
      : 0;
  const proposedDurationSeconds =
    pricePerSecondMicros > 0
      ? Math.floor(totals.totalDeductedMicros / pricePerSecondMicros)
      : totals.billingSequence > 0
        ? totals.billingSequence
        : 0;
  const proposedCoinsDeducted = microsToUserDebitWholeCoins(totals.totalDeductedMicros);
  const authoritativeCoinsDeducted = proposedCoinsDeducted;

  let eligible = settlementIssue != null;
  let skipReason: string | undefined;

  if (await isCallBillingAlreadySettled(callId)) {
    if (
      userCall &&
      userCall.durationSeconds > 0 &&
      userCall.coinsDeducted > 0 &&
      hasVideoCallDebitTxn
    ) {
      eligible = false;
      skipReason = 'already_settled_correctly';
    }
  }

  if (!eligible && !skipReason) {
    skipReason = 'no_settlement_issue_detected';
  }

  return {
    callId,
    eligible,
    skipReason,
    settlementIssue,
    billingStatus,
    callHistory: userCall
      ? {
          durationSeconds: userCall.durationSeconds,
          coinsDeducted: userCall.coinsDeducted,
          coinsEarned: userCall.coinsEarned,
          settlementStatus: userCall.settlementStatus,
        }
      : null,
    authoritativeTotals: totals,
    authoritativeCoinsDeducted,
    proposedDurationSeconds,
    proposedCoinsDeducted,
    deadLetterPresent: Boolean(deadLetterRaw),
    hasVideoCallDebitTxn,
  };
}

export async function rehydrateBillingSessionFromDurable(callId: string): Promise<boolean> {
  const durable = await getDurableCallSession(callId);
  if (!durable) {
    return false;
  }
  const totals = await resolveAuthoritativeSettlementTotals(callId);
  const totalDeductedMicros = Math.max(
    durable.totalUserDebitedMicros ?? 0,
    totals.totalDeductedMicros
  );
  const totalEarnedMicros = Math.max(
    durable.totalCreatorCreditedMicros ?? 0,
    totals.totalEarnedMicros
  );
  const pricePerSecondMicros = durable.pricePerSecondMicros ?? 0;
  const elapsedSeconds =
    pricePerSecondMicros > 0
      ? Math.floor(totalDeductedMicros / pricePerSecondMicros)
      : durable.accumulatedDurationSec ?? 0;

  const session = {
    schemaVersion: 4,
    callId,
    userFirebaseUid: durable.callerFirebaseUid,
    creatorFirebaseUid: durable.creatorFirebaseUid,
    userMongoId: durable.callerId.toString(),
    creatorMongoId: durable.creatorId.toString(),
    pricePerMinute: durable.pricePerMinute ?? 0,
    pricePerSecondMicros,
    creatorEarningsPerSecondMicros: (durable as { creatorEarningsPerSecondMicros?: number })
      .creatorEarningsPerSecondMicros ?? 0,
    startTime: durable.serverStartedAt?.getTime() ?? durable.startedAt?.getTime() ?? Date.now(),
    lastProcessedAt: durable.lastBillingAt?.getTime() ?? Date.now(),
    totalDeductedMicros,
    totalEarnedMicros,
    billingSequence: Math.max(durable.billingSequence ?? 0, totals.billingSequence),
    lifecycleState: 'ENDING',
    elapsedSeconds,
    instanceId: durable.leaseOwnerId,
  };

  await getRedis().setex(callSessionKey(callId), 7200, JSON.stringify(session));
  logInfo('admin_rehydrate_billing_session', { callId, totalDeductedMicros, elapsedSeconds });
  return true;
}

export async function executeAdminSettlementRetry(
  _io: Server,
  callId: string,
  opts?: { force?: boolean }
): Promise<{ status: 'enqueued' | 'skipped' | 'recovered'; message: string }> {
  const preview = await buildSettlementRetryPreview(callId);
  if (!preview.eligible && !opts?.force) {
    return { status: 'skipped', message: preview.skipReason ?? 'not_eligible' };
  }

  if (await isCallBillingAlreadySettled(callId)) {
    const correctlySettled =
      preview.callHistory &&
      preview.callHistory.durationSeconds > 0 &&
      preview.callHistory.coinsDeducted > 0 &&
      preview.hasVideoCallDebitTxn;
    if (correctlySettled && !opts?.force) {
      return { status: 'skipped', message: 'already_settled_correctly' };
    }
  }

  const redis = getRedis();
  await redis.del(billingRecoveryDeadLetterKey(callId)).catch(() => 0);
  await redis.del(settledCallKey(callId)).catch(() => 0);

  if (isDurableCallSessionEnabled()) {
    const durable = await getDurableCallSession(callId);
    if (durable?.state === 'failed_settlement') {
      const recovery = await attemptFailedSettlementRecovery(callId, 'reconciliation_worker', {
        forceAllowZeroSequence: opts?.force === true,
      });
      if (recovery === 'recovered' || recovery === 'dead_lettered') {
        return { status: 'recovered', message: `failed_settlement_recovery:${recovery}` };
      }
    }
    await resetDurableCallSessionForSettlementRetry(callId).catch(() => false);
  }

  await Call.updateOne(
    { callId },
    {
      $set: {
        'settlement.status': 'ending',
        'settlement.updatedAt': new Date(),
      },
      $unset: { 'settlement.settledAt': '' },
    }
  ).catch(() => {});

  await rehydrateBillingSessionFromDurable(callId);

  await enqueueImmediateSettlementRetry({
    callId,
    reason: 'reconciliation',
    source: 'reconciliation_worker',
    attempt: 0,
    enqueuedAt: Date.now(),
  });

  return { status: 'enqueued', message: 'settlement_retry_enqueued' };
}

export async function executeBulkAdminSettlementRetry(
  io: Server,
  callIds: string[],
  opts?: { force?: boolean }
): Promise<Array<{ callId: string; status: string; message: string }>> {
  const results: Array<{ callId: string; status: string; message: string }> = [];
  const limited = callIds.slice(0, 20);
  for (const callId of limited) {
    const result = await executeAdminSettlementRetry(io, callId, opts);
    results.push({ callId, status: result.status, message: result.message });
  }
  return results;
}
