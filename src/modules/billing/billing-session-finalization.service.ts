/**
 * Canonical settlement orchestration — only this module may invoke persistCallSettlement / settleCall.
 */

import { Server } from 'socket.io';
import crypto from 'crypto';
import os from 'os';
import {
  getRedis,
  callSessionKey,
  settledCallKey,
  SETTLED_CALL_TTL,
  settlementClaimKey,
  SETTLEMENT_CLAIM_TTL_SECONDS,
  BILLING_SETTLEMENT_RETRY_KEY,
} from '../../config/redis';
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
import { recordBillingMetric } from '../../utils/monitoring';
import { logError, logInfo, logWarning } from '../../utils/logger';

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

/**
 * Single orchestration entry for call settlement. Invokes persistCallSettlement only after
 * flush, ownership, and billing scheduler removal.
 */
export async function finalizeCallSession(
  io: Server,
  params: FinalizeCallSessionParams
): Promise<FinalizeResult> {
  const { callId, reason, source } = params;

  if (!isUnifiedBillingFinalizerEnabled()) {
    await settleCall(io, callId);
    return { status: 'settled', callId };
  }

  const partyContext = await readFinalizePartyContext(callId);

  logInfo('billing_finalize_begin', { callId, source, reason, ...partyContext });
  logInfo('billing_lifecycle_settle_begin', { callId, source, reason, ...partyContext });

  if (await isAlreadySettled(callId)) {
    recordBillingMetric('billing_finalize_duplicate', 1, { callId, source });
    await appendSettlementAttempt(callId, {
      source,
      reason,
      result: 'duplicate',
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

    await billingService.flushBillingToQuiescence(io, callId);
    const flushMarkerRaw = await redis.get(finalFlushMarkerKey(callId));
    if (!flushMarkerRaw) {
      logWarning('billing_finalize proceeding without final flush marker', { callId });
    }

    if (await isAlreadySettled(callId)) {
      recordBillingMetric('billing_finalize_duplicate', 1, { callId, source });
      return { status: 'duplicate', callId };
    }

    await removeCallFromBilling(callId);

    const persistResult = await settleCall(io, callId, {
      _fromFinalizer: true,
      lockToken,
      settleLockRedisKey,
    });

    if (!persistResult) {
      if (await isAlreadySettled(callId)) {
        return { status: 'duplicate', callId };
      }
      await enqueueSettlementRetry(params);
      return { status: 'pending_retry', callId };
    }

    await markCallSettled(callId, source, reason, settlementVersion);
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
      ...partyContext,
      durationSeconds: persistResult.durationSeconds,
      coinsDeducted: persistResult.totalDeducted,
      coinsEarned: persistResult.totalEarnedCreator,
      settlementVersion,
    });
    logInfo('billing_lifecycle_settle_success', {
      callId,
      source,
      reason,
      ...partyContext,
      settlementVersion,
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
    logError('billing_finalize_failure', error, { callId, source, reason, ...partyContext });
    logError('billing_lifecycle_settle_failed', error, {
      callId,
      source,
      reason,
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
