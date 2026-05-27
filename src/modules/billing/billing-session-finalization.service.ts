/**
 * Canonical settlement orchestration — only this module may invoke persistCallSettlement / settleCall.
 */

import { Server } from 'socket.io';
import crypto from 'crypto';
import os from 'os';
import {
  getRedis,
  callSessionKey,
  callUserIntroMicrosKey,
  callUserWalletMicrosKey,
  settledCallKey,
  SETTLED_CALL_TTL,
  settlementClaimKey,
  SETTLEMENT_CLAIM_TTL_SECONDS,
  BILLING_SETTLEMENT_RETRY_KEY,
} from '../../config/redis';
import { getBillingCheckpoint, upsertBillingCheckpointSnapshot } from './billing-checkpoint.service';
import { Call } from '../video/call.model';
import { CallHistory } from './call-history.model';
import { billingService, finalFlushMarkerKey } from './billing.service';
import {
  BILLING_MAX_SETTLING_MS,
  BILLING_SETTLEMENT_POLL_MS,
  BILLING_SETTLEMENT_RETRY_MAX_ATTEMPTS,
  isUnifiedBillingFinalizerEnabled,
} from './billing.constants';
import {
  deleteBillingSessionRedisKeys,
  removeCallFromBilling,
  settleCall,
  type SettlePersistResult,
} from './billing-settlement.service';
import { emitBillingSettledFromSnapshot } from './billing-emitter.service';
import { recordBillingMetric } from '../../utils/monitoring';
import { logError, logInfo, logWarning } from '../../utils/logger';
import { transitionBillingStateWithAudit } from './billing-lifecycle.machine';

export type SettlementReason =
  | 'insufficient_coins'
  | 'disconnect'
  | 'timeout'
  | 'explicit_end'
  | 'duration_limit'
  | 'reconciliation'
  | 'unknown';

export type SettlementSource =
  | 'force_end'
  | 'billing_tick'
  | 'socket_call_ended'
  | 'http_call_ended'
  | 'webhook'
  | 'reconciliation_worker'
  | 'deferred_pending_end';

export type FinalizeStatus = 'settled' | 'duplicate' | 'pending_retry' | 'failed';

export interface FinalizeCallSessionParams {
  callId: string;
  reason: SettlementReason;
  source: SettlementSource;
}

export interface FinalizeResult {
  status: FinalizeStatus;
  callId: string;
  settlementVersion?: number;
  coinsDeducted?: number;
  coinsEarned?: number;
  durationSeconds?: number;
}

type FinalizePartyContext = {
  payerFirebaseUid?: string;
  creatorFirebaseUid?: string;
  initiatedByFirebaseUid?: string;
  initiatedByRole?: 'user' | 'creator' | 'admin';
};

type FinalizationSnapshotMeta = {
  billingSequence: number;
  snapshotVersion: number;
  recoverySource: 'redis_session' | 'checkpoint_fallback' | 'missing';
};

const SETTLE_LOCK_PREFIX = 'settle:lock:';
const settleLockKey = (callId: string): string => `${SETTLE_LOCK_PREFIX}${callId}`;
const SETTLE_LOCK_TTL_SECONDS = 120;
const SETTLE_LOCK_HEARTBEAT_MS = 30_000;

const RELEASE_IF_MATCH_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

function billingInstanceId(): string {
  return (
    process.env.BILLING_INSTANCE_ID?.trim() ||
    `${os.hostname()}:${process.pid}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function appendSettlementAttempt(
  callId: string,
  entry: {
    source: SettlementSource;
    reason: SettlementReason;
    result: 'success' | 'duplicate' | 'retry' | 'failed' | 'stale_takeover';
    error?: string;
    ownerToken?: string;
    settlementVersion?: number;
  }
): Promise<void> {
  await Call.updateOne(
    { callId },
    {
      $push: {
        settlementAttempts: {
          source: entry.source,
          reason: entry.reason,
          timestamp: new Date(),
          result: entry.result,
          error: entry.error,
          ownerToken: entry.ownerToken,
          settlementVersion: entry.settlementVersion,
        },
      },
    }
  ).catch(() => {});
}

async function isAlreadySettled(callId: string): Promise<boolean> {
  const redis = getRedis();
  if (await redis.get(settledCallKey(callId))) {
    return true;
  }
  const history = await CallHistory.findOne({ callId, ownerRole: 'user' }).lean();
  if (history) {
    return true;
  }
  const call = await Call.findOne({ callId }).select('settlement.status').lean();
  return call?.settlement?.status === 'settled';
}

async function readFinalizePartyContext(callId: string): Promise<FinalizePartyContext> {
  const redis = getRedis();
  const sessionRaw = await redis.get(callSessionKey(callId));
  if (!sessionRaw) {
    return {};
  }
  try {
    const session = JSON.parse(sessionRaw) as {
      userFirebaseUid?: string;
      creatorFirebaseUid?: string;
      initiatedByFirebaseUid?: string;
      initiatedByRole?: 'user' | 'creator' | 'admin';
    };
    return {
      payerFirebaseUid: session.userFirebaseUid,
      creatorFirebaseUid: session.creatorFirebaseUid,
      initiatedByFirebaseUid: session.initiatedByFirebaseUid,
      initiatedByRole: session.initiatedByRole,
    };
  } catch {
    return {};
  }
}

async function readFinalizationSnapshotMeta(callId: string): Promise<FinalizationSnapshotMeta> {
  const redis = getRedis();
  const sessionRaw = await redis.get(callSessionKey(callId));
  if (sessionRaw) {
    try {
      const session = JSON.parse(sessionRaw) as {
        billingSequence?: number;
        version?: number;
      };
      return {
        billingSequence: Math.max(0, Number(session.billingSequence) || 0),
        snapshotVersion: Math.max(1, Number(session.version) || 1),
        recoverySource: 'redis_session',
      };
    } catch {
      return {
        billingSequence: 0,
        snapshotVersion: 1,
        recoverySource: 'redis_session',
      };
    }
  }
  const checkpoint = (await getBillingCheckpoint(callId)) as
    | { billingSequence?: number; version?: number }
    | null;
  if (checkpoint) {
    return {
      billingSequence: Math.max(0, Number(checkpoint.billingSequence) || 0),
      snapshotVersion: Math.max(1, Number(checkpoint.version) || 1),
      recoverySource: 'checkpoint_fallback',
    };
  }
  return {
    billingSequence: 0,
    snapshotVersion: 1,
    recoverySource: 'missing',
  };
}

async function pollUntilSettled(callId: string): Promise<boolean> {
  const deadline = Date.now() + BILLING_SETTLEMENT_POLL_MS;
  while (Date.now() < deadline) {
    if (await isAlreadySettled(callId)) {
      return true;
    }
    await sleep(500);
  }
  return isAlreadySettled(callId);
}

export async function enqueueSettlementRetry(
  params: FinalizeCallSessionParams & { attempt?: number }
): Promise<void> {
  const redis = getRedis();
  const attempt = (params.attempt ?? 0) + 1;
  if (attempt > BILLING_SETTLEMENT_RETRY_MAX_ATTEMPTS) {
    recordBillingMetric('billing_finalize_failure', 1, {
      callId: params.callId,
      source: params.source,
    });
    return;
  }
  const score = Date.now() + Math.min(60_000, 1000 * 2 ** attempt);
  await redis.zadd(
    BILLING_SETTLEMENT_RETRY_KEY,
    score,
    JSON.stringify({ ...params, attempt })
  );
  recordBillingMetric('billing_finalize_retry_total', 1, {
    callId: params.callId,
    source: params.source,
    attempt: String(attempt),
  });
}

export async function processSettlementRetryQueue(io: Server, maxItems = 20): Promise<void> {
  const redis = getRedis();
  const now = Date.now();
  const items = await redis.zrangebyscore(BILLING_SETTLEMENT_RETRY_KEY, 0, now, 'LIMIT', 0, maxItems);
  for (const raw of items) {
    await redis.zrem(BILLING_SETTLEMENT_RETRY_KEY, raw);
    try {
      const parsed = JSON.parse(raw) as FinalizeCallSessionParams & { attempt?: number };
      await finalizeCallSession(io, {
        callId: parsed.callId,
        reason: parsed.reason,
        source: parsed.source,
      });
    } catch (e) {
      logError('Settlement retry consumer failed', e, { raw });
    }
  }
}

async function tryStaleSettlingTakeover(callId: string): Promise<boolean> {
  const call = await Call.findOne({ callId }).lean();
  if (!call?.settlement || call.settlement.status !== 'settling') {
    return false;
  }
  const updatedAt = call.settlement.updatedAt
    ? new Date(call.settlement.updatedAt).getTime()
    : 0;
  if (Date.now() - updatedAt <= BILLING_MAX_SETTLING_MS) {
    return false;
  }

  recordBillingMetric('billing_finalize_stale_claim_total', 1, { callId });
  logWarning('billing_finalize_stale_takeover', {
    callId,
    previousOwner: call.settlement.ownerInstanceId,
    version: call.settlement.version,
  });

  const redis = getRedis();
  await redis.del(settlementClaimKey(callId)).catch(() => {});

  const newVersion = (call.settlement.version ?? 0) + 1;
  const ownerToken = crypto.randomUUID();
  const ownerInstanceId = billingInstanceId();

  await Call.updateOne(
    { callId },
    {
      $set: {
        'settlement.status': 'settling',
        'settlement.version': newVersion,
        'settlement.updatedAt': new Date(),
        'settlement.ownerToken': ownerToken,
        'settlement.ownerInstanceId': ownerInstanceId,
      },
    }
  );

  await appendSettlementAttempt(callId, {
    source: 'reconciliation_worker',
    reason: 'reconciliation',
    result: 'stale_takeover',
    ownerToken,
    settlementVersion: newVersion,
  });

  return true;
}

async function markCallSettling(
  callId: string,
  source: SettlementSource,
  reason: SettlementReason,
  ownerToken: string,
  ownerInstanceId: string
): Promise<number> {
  const version = 1;
  await Call.findOneAndUpdate(
    { callId, 'settlement.status': { $ne: 'settled' } },
    {
      $set: {
        'settlement.status': 'settling',
        'settlement.source': source,
        'settlement.reason': reason,
        'settlement.version': version,
        'settlement.updatedAt': new Date(),
        'settlement.ownerToken': ownerToken,
        'settlement.ownerInstanceId': ownerInstanceId,
      },
      $setOnInsert: {
        settlementAttempts: [],
      },
    },
    { upsert: false }
  );
  return version;
}

async function markCallSettled(
  callId: string,
  source: SettlementSource,
  reason: SettlementReason,
  version: number
): Promise<void> {
  await Call.updateOne(
    { callId },
    {
      $set: {
        isSettled: true,
        'settlement.status': 'settled',
        'settlement.source': source,
        'settlement.reason': reason,
        'settlement.settledAt': new Date(),
        'settlement.updatedAt': new Date(),
        'settlement.version': version,
      },
    }
  );
}

async function runPostPersistRedisCleanup(
  callId: string,
  result: SettlePersistResult
): Promise<void> {
  const redis = getRedis();
  try {
    await deleteBillingSessionRedisKeys(
      redis,
      callId,
      result.userFirebaseUid,
      result.creatorFirebaseUid
    );
    await redis.setex(settledCallKey(callId), SETTLED_CALL_TTL, '1');
    await redis.del(settlementClaimKey(callId));
  } catch (e) {
    logError('Post-settlement Redis cleanup failed', e, { callId, alert: true });
  }
}

async function checkpointLifecycleState(
  callId: string,
  targetState: 'SETTLING' | 'SETTLED' | 'FAILED',
  status: 'settling' | 'settled'
): Promise<void> {
  try {
    const redis = getRedis();
    const sessionRaw = await redis.get(callSessionKey(callId));
    if (!sessionRaw) return;
    const session = JSON.parse(sessionRaw) as {
      userMongoId?: string;
      creatorMongoId?: string;
      userFirebaseUid?: string;
      creatorFirebaseUid?: string;
      startTime?: number;
      lastProcessedAt?: number;
      pricePerSecondMicros?: number;
      creatorEarningsPerSecondMicros?: number;
      totalDeductedMicros?: number;
      totalEarnedMicros?: number;
      billingSequence?: number;
      lifecycleState?: 'INIT' | 'STARTING' | 'ACTIVE' | 'ENDING' | 'SETTLING' | 'SETTLED' | 'FAILED' | 'RECOVERING';
    };
    if (
      !session.userMongoId ||
      !session.creatorMongoId ||
      !session.userFirebaseUid ||
      !session.creatorFirebaseUid
    ) {
      return;
    }
    const [introRaw, walletRaw] = await Promise.all([
      redis.get(callUserIntroMicrosKey(callId)),
      redis.get(callUserWalletMicrosKey(callId)),
    ]);
    const remainingUserBalanceMicros =
      Math.max(0, parseInt(String(introRaw ?? '0'), 10) || 0) +
      Math.max(0, parseInt(String(walletRaw ?? '0'), 10) || 0);

    const currentState = (session.lifecycleState || 'ACTIVE') as
      | 'INIT'
      | 'STARTING'
      | 'ACTIVE'
      | 'ENDING'
      | 'SETTLING'
      | 'SETTLED'
      | 'FAILED'
      | 'RECOVERING';
    const transition = await transitionBillingStateWithAudit({
      callId,
      from: currentState,
      to: targetState,
      source: 'billing.finalization.checkpoint',
      reason: `checkpoint_${status}`,
    });
    session.lifecycleState = transition.next;
    await redis.set(callSessionKey(callId), JSON.stringify(session), 'KEEPTTL');

    await upsertBillingCheckpointSnapshot({
      callId,
      userMongoId: session.userMongoId,
      creatorMongoId: session.creatorMongoId,
      userFirebaseUid: session.userFirebaseUid,
      creatorFirebaseUid: session.creatorFirebaseUid,
      startTimeMs: Number(session.startTime) || Date.now(),
      lastProcessedAtMs: Number(session.lastProcessedAt) || Date.now(),
      remainingUserBalanceMicros,
      pricePerSecondMicros: Math.max(0, Number(session.pricePerSecondMicros) || 0),
      creatorEarningsPerSecondMicros: Math.max(
        0,
        Number(session.creatorEarningsPerSecondMicros) || 0
      ),
      totalDeductedMicros: Math.max(0, Number(session.totalDeductedMicros) || 0),
      totalEarnedMicros: Math.max(0, Number(session.totalEarnedMicros) || 0),
      billingSequence: Math.max(0, Number(session.billingSequence) || 0),
      lifecycleState: transition.next,
      status,
    });
  } catch (error) {
    logError('Failed lifecycle checkpoint upsert', error, { callId, targetState });
  }
}

/**
 * Single orchestration entry for call settlement. Invokes persistCallSettlement only after
 * flush, ownership, and billing scheduler removal.
 */
export async function finalizeCallSession(
  io: Server,
  params: FinalizeCallSessionParams
): Promise<FinalizeResult> {
  const { callId, reason, source } = params;
  const finalizeAttemptId = crypto.randomUUID();

  if (!isUnifiedBillingFinalizerEnabled()) {
    await settleCall(io, callId);
    return { status: 'settled', callId };
  }

  const partyContext = await readFinalizePartyContext(callId);
  const snapshotMeta = await readFinalizationSnapshotMeta(callId);

  logInfo('billing_finalize_begin', {
    callId,
    source,
    reason,
    finalizeAttemptId,
    ...snapshotMeta,
    ...partyContext,
  });
  logInfo('billing_lifecycle_settle_begin', {
    callId,
    source,
    reason,
    finalizeAttemptId,
    ...snapshotMeta,
    ...partyContext,
  });

  if (await isAlreadySettled(callId)) {
    recordBillingMetric('billing_finalize_duplicate', 1, { callId, source });
    await appendSettlementAttempt(callId, {
      source,
      reason,
      result: 'duplicate',
    });
    logInfo('billing_finalize_duplicate_suppressed', {
      callId,
      source,
      reason,
      finalizeAttemptId,
      ...snapshotMeta,
    });
    return { status: 'duplicate', callId };
  }

  await tryStaleSettlingTakeover(callId);

  const redis = getRedis();
  const ownerToken = crypto.randomUUID();
  const ownerInstanceId = billingInstanceId();
  const claimPayload = JSON.stringify({
    token: ownerToken,
    instanceId: ownerInstanceId,
    acquiredAt: Date.now(),
  });

  const claimOk = await redis.set(
    settlementClaimKey(callId),
    claimPayload,
    'EX',
    SETTLEMENT_CLAIM_TTL_SECONDS,
    'NX'
  );

  if (claimOk !== 'OK') {
    const polled = await pollUntilSettled(callId);
    if (polled) {
      recordBillingMetric('billing_finalize_duplicate', 1, { callId, source });
      logInfo('billing_finalize_duplicate_suppressed', {
        callId,
        source,
        reason,
        finalizeAttemptId,
        duplicateSuppression: 'claim_contention_poll_settled',
        ...snapshotMeta,
      });
      return { status: 'duplicate', callId };
    }
    await enqueueSettlementRetry(params);
    return { status: 'pending_retry', callId };
  }

  const lockToken = ownerToken;
  const settleLockRedisKey = settleLockKey(callId);
  const lockResult = await redis.set(
    settleLockRedisKey,
    lockToken,
    'EX',
    SETTLE_LOCK_TTL_SECONDS,
    'NX'
  );

  if (lockResult !== 'OK') {
    await redis.del(settlementClaimKey(callId)).catch(() => {});
    const polled = await pollUntilSettled(callId);
    if (polled) {
      logInfo('billing_finalize_duplicate_suppressed', {
        callId,
        source,
        reason,
        finalizeAttemptId,
        duplicateSuppression: 'settle_lock_contention_poll_settled',
        ...snapshotMeta,
      });
      return { status: 'duplicate', callId };
    }
    recordBillingMetric('billing_finalize_claim_timeout_total', 1, { callId, source });
    await enqueueSettlementRetry(params);
    return { status: 'pending_retry', callId };
  }

  const lockHeartbeat = setInterval(() => {
    redis
      .set(settleLockRedisKey, lockToken, 'EX', SETTLE_LOCK_TTL_SECONDS, 'XX')
      .catch(() => {});
  }, SETTLE_LOCK_HEARTBEAT_MS);

  let settlementVersion = 1;

  try {
    settlementVersion = await markCallSettling(callId, source, reason, ownerToken, ownerInstanceId);
    await checkpointLifecycleState(callId, 'SETTLING', 'settling');

    await billingService.flushBillingToQuiescence(io, callId);
    const flushMarkerRaw = await redis.get(finalFlushMarkerKey(callId));
    if (!flushMarkerRaw) {
      logWarning('billing_finalize proceeding without final flush marker', { callId });
    }

    if (await isAlreadySettled(callId)) {
      recordBillingMetric('billing_finalize_duplicate', 1, { callId, source });
      logInfo('billing_finalize_duplicate_suppressed', {
        callId,
        source,
        reason,
        finalizeAttemptId,
        duplicateSuppression: 'post_flush_duplicate_guard',
        ...snapshotMeta,
      });
      return { status: 'duplicate', callId };
    }

    await removeCallFromBilling(callId);

    const persistResult = await settleCall(io, callId, {
      _fromFinalizer: true,
      lockToken,
      settleLockRedisKey,
      suppressSettledEmit: true,
    });

    if (!persistResult) {
      if (await isAlreadySettled(callId)) {
        return { status: 'duplicate', callId };
      }
      await enqueueSettlementRetry(params);
      return { status: 'pending_retry', callId };
    }

    await markCallSettled(callId, source, reason, settlementVersion);
    await checkpointLifecycleState(callId, 'SETTLED', 'settled');
    emitBillingSettledFromSnapshot(
      io,
      persistResult.userFirebaseUid,
      persistResult.creatorFirebaseUid,
      {
        callId,
        billingSequence: persistResult.billingSequence,
        lifecycleState: 'SETTLED',
        finalCoins: persistResult.finalUserCoins,
        totalDeducted: persistResult.totalDeducted,
        durationSeconds: persistResult.durationSeconds,
      },
      {
        callId,
        billingSequence: persistResult.billingSequence,
        lifecycleState: 'SETTLED',
        totalEarned: persistResult.totalEarnedCreator,
        durationSeconds: persistResult.durationSeconds,
      }
    );
    await runPostPersistRedisCleanup(callId, persistResult);

    await appendSettlementAttempt(callId, {
      source,
      reason,
      result: 'success',
      ownerToken,
      settlementVersion,
    });

    recordBillingMetric('billing_finalize_success', 1, {
      callId,
      source,
      coinsDeducted: String(persistResult.totalDeducted),
      coinsEarned: String(persistResult.totalEarnedCreator),
    });

    logInfo('billing_finalize_success', {
      callId,
      source,
      reason,
      finalizeAttemptId,
      ...partyContext,
      durationSeconds: persistResult.durationSeconds,
      coinsDeducted: persistResult.totalDeducted,
      coinsEarned: persistResult.totalEarnedCreator,
      settlementVersion,
      ...snapshotMeta,
    });
    logInfo('billing_lifecycle_settle_success', {
      callId,
      source,
      reason,
      finalizeAttemptId,
      ...partyContext,
      settlementVersion,
      ...snapshotMeta,
    });

    return {
      status: 'settled',
      callId,
      settlementVersion,
      coinsDeducted: persistResult.totalDeducted,
      coinsEarned: persistResult.totalEarnedCreator,
      durationSeconds: persistResult.durationSeconds,
    };
  } catch (error) {
    await checkpointLifecycleState(callId, 'FAILED', 'settling');
    logError('billing_finalize_failure', error, {
      callId,
      source,
      reason,
      finalizeAttemptId,
      ...snapshotMeta,
      ...partyContext,
    });
    logError('billing_lifecycle_settle_failed', error, {
      callId,
      source,
      reason,
      finalizeAttemptId,
      ...snapshotMeta,
      ...partyContext,
    });
    recordBillingMetric('billing_finalize_failure', 1, { callId, source });
    await appendSettlementAttempt(callId, {
      source,
      reason,
      result: 'failed',
      error: error instanceof Error ? error.message : String(error),
      ownerToken,
      settlementVersion,
    });
    await enqueueSettlementRetry(params);
    return { status: 'pending_retry', callId };
  } finally {
    clearInterval(lockHeartbeat);
    await redis.eval(RELEASE_IF_MATCH_LUA, 1, settleLockRedisKey, lockToken).catch(() => {});
    await redis.del(settlementClaimKey(callId)).catch(() => {});
  }
}
