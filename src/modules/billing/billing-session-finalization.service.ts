/**
 * Canonical settlement orchestration — only this module may invoke persistCallSettlement / settleCall.
 */

import { Server } from 'socket.io';
import crypto from 'crypto';
import {
  billingInstanceIdsMatch,
  getBillingInstanceId,
} from './billing-instance-id';
import {
  getRedis,
  callSessionKey,
  callUserIntroMicrosKey,
  callUserWalletMicrosKey,
  settledCallKey,
  callSessionTerminalKey,
  BILLING_TERMINAL_TOMBSTONE_TTL_SECONDS,
  SETTLED_CALL_TTL,
  settlementClaimKey,
  SETTLEMENT_CLAIM_TTL_SECONDS,
  BILLING_SETTLEMENT_RETRY_KEY,
  billingSettlementRetryPayloadKey,
  billingSettlementRetryDedupKey,
  finalizeInflightKey,
  isInvalidBillingCallId,
  billingWatchdogAttemptsKey,
  billingWatchdogCooldownKey,
  billingRecoveryDeadLetterKey,
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
import { cancelBillingCycleJob } from './billing.queue';
import { featureFlags } from '../../config/feature-flags';
import {
  claimDurableCallSessionForSettlement,
  isDurableCallSessionFinalized,
  markDurableCallSessionFailedSettlement,
  markDurableCallSessionSettled,
} from './call-session.service';
import { isDurableCallSessionEnabled, isBillingOutboxProjectionEnabled } from './billing-phase-flags';
import { recordFinalizeDuplicatePrevented, recordSettlementRetry } from './billing-phase-metrics';
import { enqueueCallBillingProjectionEvent } from './call-history-projector.service';
import { resolveBillingRuntimeState } from './billing-runtime-resolver.service';

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

export type FinalizeStatus = 'settled' | 'duplicate' | 'pending_retry' | 'failed' | 'dead_lettered';

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
const FINALIZE_INFLIGHT_TTL_SECONDS = Math.min(
  600,
  Math.max(30, parseInt(process.env.BILLING_FINALIZE_INFLIGHT_TTL_SECONDS || '120', 10) || 120)
);
const RETRY_DEDUP_TTL_SECONDS = Math.min(
  900,
  Math.max(30, parseInt(process.env.BILLING_SETTLEMENT_RETRY_DEDUP_TTL_SECONDS || '180', 10) || 180)
);
const RETRY_MAX_AGE_MS = Math.min(
  3_600_000,
  Math.max(
    60_000,
    parseInt(process.env.BILLING_SETTLEMENT_RETRY_MAX_AGE_MS || '900000', 10) || 900_000
  )
);
const RETRY_JITTER_MS = Math.min(
  5000,
  Math.max(0, parseInt(process.env.BILLING_SETTLEMENT_RETRY_JITTER_MS || '500', 10) || 500)
);

const RELEASE_IF_MATCH_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const DEAD_LETTER_LIFECYCLE_STATE = 'FAILED_RECOVERY_SETTLEMENT' as const;
const ACTIVE_RUNTIME_FINALIZE_GUARD_MS = Math.min(
  120_000,
  Math.max(5_000, parseInt(process.env.BILLING_ACTIVE_RUNTIME_FINALIZE_GUARD_MS || '45000', 10) || 45_000)
);
const FINALIZE_CONVERGENCE_RETRY_ENABLED = featureFlags.billingFinalizeConvergenceRetryEnabled;
const FINALIZE_CONVERGENCE_MAX_ATTEMPTS = Math.max(
  1,
  Math.min(5, parseInt(process.env.BILLING_FINALIZE_CONVERGENCE_MAX_ATTEMPTS || '3', 10) || 3)
);
const FINALIZE_CONVERGENCE_BACKOFF_MS = Math.max(
  10,
  Math.min(1000, parseInt(process.env.BILLING_FINALIZE_CONVERGENCE_BACKOFF_MS || '80', 10) || 80)
);

export function getRecoveryOwnerInstanceId(): string {
  return getBillingInstanceId();
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

async function clearSettlementRetryArtifacts(callId: string): Promise<void> {
  const redis = getRedis();
  await Promise.all([
    redis.zrem(BILLING_SETTLEMENT_RETRY_KEY, callId).catch(() => 0),
    redis.del(billingSettlementRetryPayloadKey(callId)).catch(() => 0),
    redis.del(billingSettlementRetryDedupKey(callId)).catch(() => 0),
  ]);
}

type DrainArtifactsReason =
  | 'attempt_cap_reached'
  | 'dead_letter_transition'
  | 'convergence_impossible'
  | 'manual_cleanup';

export async function drainSettlementArtifacts(
  callId: string,
  reason: DrainArtifactsReason
): Promise<void> {
  const redis = getRedis();
  await Promise.all([
    cancelBillingCycleJob(callId).catch(() => {}),
    clearSettlementRetryArtifacts(callId),
    redis.del(settlementClaimKey(callId)).catch(() => 0),
    redis.del(settleLockKey(callId)).catch(() => 0),
    redis.del(finalizeInflightKey(callId)).catch(() => 0),
    redis.del(billingWatchdogCooldownKey(callId)).catch(() => 0),
    redis.del(billingWatchdogAttemptsKey(callId)).catch(() => 0),
  ]);
  logWarning('billing_settlement_artifacts_drained', { callId, reason });
}

type DeadLetterReason =
  | 'watchdog_attempt_cap_reached'
  | 'retry_cap_reached'
  | 'retry_age_exhausted'
  | 'cooldown_exhausted'
  | 'convergence_impossible';

export async function moveCallToRecoveryDeadLetter(
  callId: string,
  reason: DeadLetterReason,
  source: SettlementSource,
  metadata?: Record<string, unknown>
): Promise<void> {
  const redis = getRedis();
  const recoveryOwnerInstanceId = getBillingInstanceId();
  const now = Date.now();
  const deadLetterKey = billingRecoveryDeadLetterKey(callId);
  await redis.setex(
    deadLetterKey,
    Math.max(300, BILLING_MAX_SETTLING_MS / 1000),
    JSON.stringify({ reason, source, at: now, recoveryOwnerInstanceId, metadata })
  );

  try {
    const sessionRaw = await redis.get(callSessionKey(callId));
    if (sessionRaw) {
      const session = JSON.parse(sessionRaw) as {
        lifecycleState?: 'INIT' | 'STARTING' | 'ACTIVE' | 'ENDING' | 'SETTLING' | 'SETTLED' | 'FAILED' | 'RECOVERING' | 'FAILED_RECOVERY_SETTLEMENT';
      };
      const fromState = (session.lifecycleState || 'FAILED') as
        | 'INIT'
        | 'STARTING'
        | 'ACTIVE'
        | 'ENDING'
        | 'SETTLING'
        | 'SETTLED'
        | 'FAILED'
        | 'RECOVERING'
        | 'FAILED_RECOVERY_SETTLEMENT';
      const transition = await transitionBillingStateWithAudit({
        callId,
        from: fromState,
        to: DEAD_LETTER_LIFECYCLE_STATE,
        source: `billing.${source}.dead_letter`,
        reason,
      });
      session.lifecycleState = transition.next;
      await redis.set(callSessionKey(callId), JSON.stringify(session), 'KEEPTTL');
    }
  } catch (error) {
    logError('billing_recovery_dead_letter_transition_failed', error, { callId, reason, source });
  }

  await Call.updateOne(
    { callId },
    {
      $set: {
        'settlement.status': 'failed_recovery_settlement',
        'settlement.reason': reason,
        'settlement.source': source,
        'settlement.updatedAt': new Date(now),
        'settlement.ownerInstanceId': recoveryOwnerInstanceId,
      },
    }
  ).catch(() => {});

  await appendSettlementAttempt(callId, {
    source,
    reason: 'reconciliation',
    result: 'failed',
    error: `dead_letter:${reason}`,
  });
  await drainSettlementArtifacts(callId, 'dead_letter_transition');
  if (isDurableCallSessionEnabled()) {
    await markDurableCallSessionFailedSettlement(callId).catch(() => {});
  }
  if (isBillingOutboxProjectionEnabled()) {
    const runtime = await resolveBillingRuntimeState(callId).catch(() => null);
    const session = runtime?.session;
    await enqueueCallBillingProjectionEvent({
      type: 'call.billing.failed_settlement',
      callId,
      payload: {
        userMongoId: session?.userMongoId,
        creatorMongoId: session?.creatorMongoId,
        userFirebaseUid: session?.userFirebaseUid,
        creatorFirebaseUid: session?.creatorFirebaseUid,
      },
    }).catch(() => {});
  }
  recordBillingMetric('billing_recovery_dead_letter_total', 1, {
    callId,
    reason,
    source,
    recoveryOwnerInstanceId,
  });
  logError('billing_recovery_dead_letter_transition', new Error(reason), {
    callId,
    reason,
    source,
    recoveryOwnerInstanceId,
    metadata,
    alert: true,
  });
}

async function isAlreadySettled(callId: string): Promise<boolean> {
  const redis = getRedis();
  if (await redis.get(settledCallKey(callId))) {
    return true;
  }
  if (await isDurableCallSessionFinalized(callId)) {
    return true;
  }
  const history = await CallHistory.findOne({ callId, ownerRole: 'user' })
    .select('settlementStatus settledAt coinsDeducted')
    .lean();
  if (history) {
    if (history.settlementStatus === 'settled' || history.settledAt) {
      return true;
    }
    if (history.settlementStatus !== 'pending' && (history.coinsDeducted ?? 0) > 0) {
      return true;
    }
  }
  const call = await Call.findOne({ callId }).select('settlement.status isSettled').lean();
  return call?.settlement?.status === 'settled';
}

/** Cancel BullMQ cycles and remove residual runtime keys when settlement already completed. */
async function ensureTerminalBillingTeardown(callId: string): Promise<void> {
  if (!(await isAlreadySettled(callId))) {
    return;
  }
  await cancelBillingCycleJob(callId).catch(() => {});

  const redis = getRedis();
  const sessionRaw = await redis.get(callSessionKey(callId));
  if (!sessionRaw) {
    return;
  }
  try {
    const session = JSON.parse(sessionRaw) as {
      userFirebaseUid?: string;
      creatorFirebaseUid?: string;
    };
    const userFirebaseUid = session.userFirebaseUid;
    const creatorFirebaseUid = session.creatorFirebaseUid;
    if (userFirebaseUid && creatorFirebaseUid) {
      await deleteBillingSessionRedisKeys(redis, callId, userFirebaseUid, creatorFirebaseUid);
    } else {
      await redis.del(callSessionKey(callId)).catch(() => 0);
    }
  } catch {
    await redis.del(callSessionKey(callId)).catch(() => 0);
  }
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
  const now = Date.now();
  const attempt = (params.attempt ?? 0) + 1;
  const enqueuedAt = (params as { enqueuedAt?: number }).enqueuedAt ?? now;
  const ageMs = Math.max(0, now - enqueuedAt);
  const recoveryOwnerInstanceId = getBillingInstanceId();

  if (ageMs > RETRY_MAX_AGE_MS) {
    await moveCallToRecoveryDeadLetter(params.callId, 'retry_age_exhausted', params.source);
    return;
  }

  if (attempt > BILLING_SETTLEMENT_RETRY_MAX_ATTEMPTS) {
    recordBillingMetric('billing_finalize_failure', 1, {
      callId: params.callId,
      source: params.source,
    });
    await moveCallToRecoveryDeadLetter(params.callId, 'retry_cap_reached', params.source);
    return;
  }

  const dedupKey = billingSettlementRetryDedupKey(params.callId);
  const dedupeSet = await redis.set(
    dedupKey,
    JSON.stringify({ attempt, at: now }),
    'EX',
    RETRY_DEDUP_TTL_SECONDS,
    'NX'
  );
  if (dedupeSet !== 'OK') {
    recordBillingMetric('billing_finalize_retry_deduped', 1, {
      callId: params.callId,
      source: params.source,
      attempt: String(attempt),
    });
    return;
  }

  const jitterMs = RETRY_JITTER_MS > 0 ? Math.floor(Math.random() * (RETRY_JITTER_MS + 1)) : 0;
  const score = now + Math.min(60_000, 1000 * 2 ** attempt) + jitterMs;
  const payload = JSON.stringify({
    ...params,
    attempt,
    enqueuedAt,
    lastEnqueuedAt: now,
    recoveryOwnerInstanceId,
  });
  await redis.setex(
    billingSettlementRetryPayloadKey(params.callId),
    Math.max(120, Math.floor(RETRY_MAX_AGE_MS / 1000)),
    payload
  );
  await redis.zadd(BILLING_SETTLEMENT_RETRY_KEY, score, params.callId);
  recordSettlementRetry(params.callId, params.source);
  recordBillingMetric('billing_finalize_retry_total', 1, {
    callId: params.callId,
    source: params.source,
    attempt: String(attempt),
    recoveryOwnerInstanceId,
  });
}

export async function processSettlementRetryQueue(io: Server, maxItems = 20): Promise<void> {
  const redis = getRedis();
  const now = Date.now();
  const items = await redis.zrangebyscore(BILLING_SETTLEMENT_RETRY_KEY, 0, now, 'LIMIT', 0, maxItems);
  for (const item of items) {
    await redis.zrem(BILLING_SETTLEMENT_RETRY_KEY, item);
    try {
      const payloadKey = billingSettlementRetryPayloadKey(item);
      const payloadRaw = await redis.get(payloadKey);
      if (!payloadRaw) {
        if (item.startsWith('{')) {
          const legacy = JSON.parse(item) as FinalizeCallSessionParams;
          await finalizeCallSession(io, {
            callId: legacy.callId,
            reason: legacy.reason,
            source: legacy.source,
          });
        }
        await redis.del(billingSettlementRetryDedupKey(item)).catch(() => 0);
        continue;
      }
      const parsed = JSON.parse(payloadRaw) as FinalizeCallSessionParams & { attempt?: number };
      await Promise.all([
        redis.del(payloadKey).catch(() => 0),
        redis.del(billingSettlementRetryDedupKey(item)).catch(() => 0),
      ]);
      await finalizeCallSession(io, {
        callId: parsed.callId,
        reason: parsed.reason,
        source: parsed.source,
      });
    } catch (e) {
      logError('Settlement retry consumer failed', e, { item });
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
  const ownerInstanceId = getBillingInstanceId();

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
  result: SettlePersistResult,
  reason: SettlementReason,
  source: SettlementSource
): Promise<void> {
  const redis = getRedis();
  try {
    const terminalSnapshot = {
      callId,
      lifecycleState: 'SETTLED' as const,
      billingSequence: Math.max(0, Number(result.billingSequence) || 0),
      elapsedSeconds: Math.max(0, Number(result.durationSeconds) || 0),
      durationSeconds: Math.max(0, Number(result.durationSeconds) || 0),
      finalCoins: Math.max(0, Number(result.finalUserCoins) || 0),
      totalDeducted: Math.max(0, Number(result.totalDeducted) || 0),
      totalEarned: Math.max(0, Number(result.totalEarnedCreator) || 0),
      settledAt: Date.now(),
      reason,
      source,
    };
    await redis.setex(
      callSessionTerminalKey(callId),
      BILLING_TERMINAL_TOMBSTONE_TTL_SECONDS,
      JSON.stringify(terminalSnapshot)
    );
    await deleteBillingSessionRedisKeys(
      redis,
      callId,
      result.userFirebaseUid,
      result.creatorFirebaseUid
    );
    const residualSessionExists = (await redis.exists(callSessionKey(callId)).catch(() => 0)) === 1;
    if (residualSessionExists) {
      recordBillingMetric('billing_finalize_residual_runtime_after_cleanup', 1, {
        callId,
        source,
      });
      logWarning('billing_finalize_residual_runtime_after_cleanup', {
        callId,
        source,
        reason,
      });
      await redis.del(callSessionKey(callId)).catch(() => 0);
    }
    await redis.setex(settledCallKey(callId), SETTLED_CALL_TTL, '1');
    await redis.del(settlementClaimKey(callId));
  } catch (e) {
    logError('Post-settlement Redis cleanup failed', e, { callId, alert: true });
  }
}

async function checkpointLifecycleState(
  callId: string,
  targetState: 'SETTLING' | 'SETTLED' | 'FAILED' | 'FAILED_RECOVERY_SETTLEMENT',
  status: 'settling' | 'settled' | 'failed'
): Promise<boolean> {
  const redis = getRedis();
  const maxAttempts = FINALIZE_CONVERGENCE_RETRY_ENABLED ? FINALIZE_CONVERGENCE_MAX_ATTEMPTS : 1;
  const reachedOrBeyondSettling = (state: string): boolean =>
    state === 'SETTLING' || state === 'SETTLED' || state === 'FAILED_RECOVERY_SETTLEMENT';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      let sessionRaw = await redis.get(callSessionKey(callId));
      if (!sessionRaw) {
        const checkpoint = (await getBillingCheckpoint(callId)) as Record<string, unknown> | null;
        if (checkpoint) {
          const reconstructedSession = {
            callId,
            schemaVersion: 1,
            userMongoId: String(checkpoint.userMongoId || ''),
            creatorMongoId: String(checkpoint.creatorMongoId || ''),
            userFirebaseUid: String(checkpoint.userFirebaseUid || ''),
            creatorFirebaseUid: String(checkpoint.creatorFirebaseUid || ''),
            startTime: Number(checkpoint.startTimeMs) || Date.now(),
            lastProcessedAt: Number(checkpoint.lastProcessedAtMs) || Date.now(),
            pricePerSecondMicros: Math.max(0, Number(checkpoint.pricePerSecondMicros) || 0),
            creatorEarningsPerSecondMicros: Math.max(
              0,
              Number(checkpoint.creatorEarningsPerSecondMicros) || 0
            ),
            totalDeductedMicros: Math.max(0, Number(checkpoint.totalDeductedMicros) || 0),
            totalEarnedMicros: Math.max(0, Number(checkpoint.totalEarnedMicros) || 0),
            billingSequence: Math.max(0, Number(checkpoint.billingSequence) || 0),
            lifecycleState: String(checkpoint.lifecycleState || 'RECOVERING'),
            version: Math.max(1, Number(checkpoint.version) || 1),
          };
          if (
            reconstructedSession.userMongoId &&
            reconstructedSession.creatorMongoId &&
            reconstructedSession.userFirebaseUid &&
            reconstructedSession.creatorFirebaseUid
          ) {
            await redis.setex(callSessionKey(callId), 7200, JSON.stringify(reconstructedSession));
            sessionRaw = JSON.stringify(reconstructedSession);
            recordBillingMetric('billing_finalize_convergence_retry_total', 1, {
              callId,
              reason: 'reconstructed_from_checkpoint',
              attempt: String(attempt),
            });
            logWarning('billing_lifecycle_checkpoint_reconstructed_from_checkpoint', {
              callId,
              attempt,
              targetState,
              status,
            });
          }
        }
      }
      if (!sessionRaw) {
        if (attempt < maxAttempts) {
          recordBillingMetric('billing_finalize_convergence_retry_total', 1, {
            callId,
            reason: 'missing_session',
            attempt: String(attempt),
          });
          await sleep(FINALIZE_CONVERGENCE_BACKOFF_MS * attempt);
          continue;
        }
        return false;
      }

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
        lifecycleState?: 'INIT' | 'STARTING' | 'ACTIVE' | 'ENDING' | 'SETTLING' | 'SETTLED' | 'FAILED' | 'RECOVERING' | 'FAILED_RECOVERY_SETTLEMENT';
      };
      if (
        !session.userMongoId ||
        !session.creatorMongoId ||
        !session.userFirebaseUid ||
        !session.creatorFirebaseUid
      ) {
        if (attempt < maxAttempts) {
          recordBillingMetric('billing_finalize_convergence_retry_total', 1, {
            callId,
            reason: 'session_missing_parties',
            attempt: String(attempt),
          });
          await sleep(FINALIZE_CONVERGENCE_BACKOFF_MS * attempt);
          continue;
        }
        return false;
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
        | 'RECOVERING'
        | 'FAILED_RECOVERY_SETTLEMENT';
      const transitionPlan: Array<
        'ENDING' | 'SETTLING' | 'SETTLED' | 'FAILED' | 'FAILED_RECOVERY_SETTLEMENT'
      > = [];
      if (
        targetState === 'SETTLING' &&
        (currentState === 'ACTIVE' || currentState === 'RECOVERING' || currentState === 'STARTING')
      ) {
        transitionPlan.push('ENDING', 'SETTLING');
      } else if (targetState === 'SETTLING') {
        transitionPlan.push('SETTLING');
      } else {
        transitionPlan.push(targetState);
      }

      let nextState = currentState;
      let shouldRetryConvergence = false;
      for (const nextTarget of transitionPlan) {
        const transition = await transitionBillingStateWithAudit({
          callId,
          from: nextState,
          to: nextTarget,
          source: 'billing.finalization.checkpoint',
          reason: `checkpoint_${status}`,
        });
        if (!transition.valid) {
          if (targetState === 'SETTLING' && reachedOrBeyondSettling(nextState)) {
            break;
          }
          logWarning('billing_lifecycle_checkpoint_transition_blocked', {
            callId,
            attempt,
            from: nextState,
            requestedTo: nextTarget,
            targetState,
            status,
          });
          if (attempt < maxAttempts) {
            recordBillingMetric('billing_finalize_convergence_retry_total', 1, {
              callId,
              reason: 'transition_blocked',
              attempt: String(attempt),
            });
            shouldRetryConvergence = true;
            break;
          }
          return false;
        }
        nextState = transition.next;
      }
      if (shouldRetryConvergence) {
        await sleep(FINALIZE_CONVERGENCE_BACKOFF_MS * attempt);
        continue;
      }
      session.lifecycleState = nextState;
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
        lifecycleState: nextState,
        status,
      });
      return targetState === 'SETTLING' ? reachedOrBeyondSettling(nextState) : nextState === targetState;
    } catch (error) {
      if (attempt >= maxAttempts) {
        logError('Failed lifecycle checkpoint upsert', error, { callId, targetState, attempt });
        return false;
      }
      recordBillingMetric('billing_finalize_convergence_retry_total', 1, {
        callId,
        reason: 'exception',
        attempt: String(attempt),
      });
      await sleep(FINALIZE_CONVERGENCE_BACKOFF_MS * attempt);
    }
  }
  return false;
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
  if (isInvalidBillingCallId(callId)) {
    logWarning('billing_finalize_rejected_invalid_call_id', { callId, source, reason });
    recordBillingMetric('billing_finalize_invalid_call_id', 1, { callId, source });
    return { status: 'duplicate', callId };
  }
  const finalizeAttemptId = crypto.randomUUID();
  const recoveryOwnerInstanceId = getBillingInstanceId();
  const reconciliationWorkerId =
    source === 'reconciliation_worker' ? recoveryOwnerInstanceId : undefined;

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
    recoveryOwnerInstanceId,
    reconciliationWorkerId,
    ...snapshotMeta,
    ...partyContext,
  });
  logInfo('billing_lifecycle_settle_begin', {
    callId,
    source,
    reason,
    finalizeAttemptId,
    recoveryOwnerInstanceId,
    reconciliationWorkerId,
    ...snapshotMeta,
    ...partyContext,
  });

  const redis = getRedis();
  const deadLetterRaw = await redis.get(billingRecoveryDeadLetterKey(callId));
  if (deadLetterRaw) {
    logWarning('billing_finalize_dead_letter_suppressed', {
      callId,
      source,
      reason,
      finalizeAttemptId,
      suppressionReason: 'recovery_dead_letter',
      recoveryOwnerInstanceId,
      reconciliationWorkerId,
    });
    return { status: 'dead_lettered', callId };
  }

  const inflightToken = crypto.randomUUID();
  const inflightOk = await redis.set(
    finalizeInflightKey(callId),
    inflightToken,
    'EX',
    FINALIZE_INFLIGHT_TTL_SECONDS,
    'NX'
  );
  if (inflightOk !== 'OK') {
    logInfo('billing_finalize_duplicate_suppressed', {
      callId,
      source,
      reason,
      finalizeAttemptId,
      duplicateSuppression: 'inflight_guard_hit',
      suppressionReason: 'inflight_guard_hit',
      recoveryOwnerInstanceId,
      reconciliationWorkerId,
      ...snapshotMeta,
    });
    recordBillingMetric('billing_finalize_duplicate', 1, { callId, source });
    return { status: 'duplicate', callId };
  }

  const activeSessionRaw = await redis.get(callSessionKey(callId));
  if (activeSessionRaw) {
    try {
      const activeSession = JSON.parse(activeSessionRaw) as {
        lifecycleState?: string;
        instanceId?: string;
        runtimeEpoch?: number;
        lastSequenceAdvanceAt?: number;
      };
      const lifecycleState = String(activeSession.lifecycleState || 'ACTIVE');
      const ownerInstanceId = String(activeSession.instanceId || '');
      const lastSequenceAdvanceAt = Number(activeSession.lastSequenceAdvanceAt) || 0;
      const sequenceAdvancedRecently =
        lastSequenceAdvanceAt > 0 && Date.now() - lastSequenceAdvanceAt <= ACTIVE_RUNTIME_FINALIZE_GUARD_MS;
      if (
        lifecycleState === 'ACTIVE' &&
        ownerInstanceId &&
        !billingInstanceIdsMatch(ownerInstanceId, recoveryOwnerInstanceId) &&
        sequenceAdvancedRecently
      ) {
        recordBillingMetric('billing_runtime_epoch_reject_stale_worker', 1, {
          callId,
          source,
          ownerInstanceId,
          runtimeEpoch: String(Math.max(1, Number(activeSession.runtimeEpoch) || 1)),
          workerInstanceId: recoveryOwnerInstanceId,
        });
        logWarning('billing_finalize_rejected_stale_worker', {
          callId,
          source,
          reason,
          ownerInstanceId,
          workerInstanceId: recoveryOwnerInstanceId,
          lastSequenceAdvanceAt,
          lifecycleState,
        });
        await redis
          .eval(RELEASE_IF_MATCH_LUA, 1, finalizeInflightKey(callId), inflightToken)
          .catch(() => {});
        return { status: 'duplicate', callId };
      }
    } catch {
      // best-effort guard only
    }
  }

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
    await ensureTerminalBillingTeardown(callId);
    await redis.eval(RELEASE_IF_MATCH_LUA, 1, finalizeInflightKey(callId), inflightToken).catch(() => {});
    return { status: 'duplicate', callId };
  }

  await tryStaleSettlingTakeover(callId);

  const ownerToken = crypto.randomUUID();
  const ownerInstanceId = getBillingInstanceId();
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
      await ensureTerminalBillingTeardown(callId);
      await redis
        .eval(RELEASE_IF_MATCH_LUA, 1, finalizeInflightKey(callId), inflightToken)
        .catch(() => {});
      return { status: 'duplicate', callId };
    }
    await enqueueSettlementRetry(params);
    await redis.eval(RELEASE_IF_MATCH_LUA, 1, finalizeInflightKey(callId), inflightToken).catch(() => {});
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
      await ensureTerminalBillingTeardown(callId);
      await redis
        .eval(RELEASE_IF_MATCH_LUA, 1, finalizeInflightKey(callId), inflightToken)
        .catch(() => {});
      return { status: 'duplicate', callId };
    }
    recordBillingMetric('billing_finalize_claim_timeout_total', 1, { callId, source });
    await enqueueSettlementRetry(params);
    await redis.eval(RELEASE_IF_MATCH_LUA, 1, finalizeInflightKey(callId), inflightToken).catch(() => {});
    return { status: 'pending_retry', callId };
  }

  const lockHeartbeat = setInterval(() => {
    redis
      .set(settleLockRedisKey, lockToken, 'EX', SETTLE_LOCK_TTL_SECONDS, 'XX')
      .catch(() => {});
  }, SETTLE_LOCK_HEARTBEAT_MS);

  let settlementVersion = 1;

  try {
    if (isDurableCallSessionEnabled()) {
      const claim = await claimDurableCallSessionForSettlement({
        callId,
        reason,
        source,
      });
      if (!claim.ok) {
        if (claim.reason === 'already_finalized') {
          recordFinalizeDuplicatePrevented(callId, source);
          recordBillingMetric('billing_finalize_duplicate', 1, { callId, source });
          await ensureTerminalBillingTeardown(callId);
          return { status: 'duplicate', callId };
        }
        await enqueueSettlementRetry(params);
        return { status: 'pending_retry', callId };
      }
      settlementVersion = claim.settlementVersion;
    } else {
      settlementVersion = await markCallSettling(callId, source, reason, ownerToken, ownerInstanceId);
    }
    const checkpointOk = await checkpointLifecycleState(callId, 'SETTLING', 'settling');
    if (!checkpointOk) {
      if (snapshotMeta.recoverySource === 'missing') {
        recordBillingMetric('billing_finalize_convergence_deferred', 1, {
          callId,
          source,
          reason: 'runtime_missing',
        });
        logWarning('billing_finalize_convergence_deferred_runtime_missing', {
          callId,
          source,
          reason,
          finalizeAttemptId,
          recoveryOwnerInstanceId,
        });
        await enqueueSettlementRetry(params);
        return { status: 'pending_retry', callId };
      }
      await moveCallToRecoveryDeadLetter(callId, 'convergence_impossible', source, {
        finalizer: 'finalizeCallSession',
        checkpointTargetState: 'SETTLING',
        checkpointStatus: 'settling',
        maxAttempts: FINALIZE_CONVERGENCE_RETRY_ENABLED ? FINALIZE_CONVERGENCE_MAX_ATTEMPTS : 1,
      });
      return { status: 'dead_lettered', callId };
    }

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
      await ensureTerminalBillingTeardown(callId);
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
        await ensureTerminalBillingTeardown(callId);
        return { status: 'duplicate', callId };
      }
      await enqueueSettlementRetry(params);
      return { status: 'pending_retry', callId };
    }

    await markCallSettled(callId, source, reason, settlementVersion);
    await markDurableCallSessionSettled({ callId, settlementVersion });
    if (isBillingOutboxProjectionEnabled()) {
      const { enqueueCallBillingProjectionEvent } = await import('./call-history-projector.service');
      await enqueueCallBillingProjectionEvent({
        type: 'call.billing.settled',
        callId,
        payload: {
          coinsDeducted: persistResult.totalDeducted,
          coinsEarned: persistResult.totalEarnedCreator,
          durationSeconds: persistResult.durationSeconds,
          userMongoId: persistResult.userFirebaseUid,
        },
      }).catch(() => {});
    }
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
    await runPostPersistRedisCleanup(callId, persistResult, reason, source);

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
      recoveryOwnerInstanceId,
      reconciliationWorkerId,
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
      recoveryOwnerInstanceId,
      reconciliationWorkerId,
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
    await checkpointLifecycleState(callId, 'FAILED', 'failed');
    logError('billing_finalize_failure', error, {
      callId,
      source,
      reason,
      finalizeAttemptId,
      recoveryOwnerInstanceId,
      ...snapshotMeta,
      ...partyContext,
    });
    logError('billing_lifecycle_settle_failed', error, {
      callId,
      source,
      reason,
      finalizeAttemptId,
      recoveryOwnerInstanceId,
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
    await redis.eval(RELEASE_IF_MATCH_LUA, 1, finalizeInflightKey(callId), inflightToken).catch(() => {});
  }
}
