import mongoose from 'mongoose';
import {
  DurableCallSession,
  type DurableCallSessionState,
  type FinalizationReason,
  type IDurableCallSession,
} from './call-session.model';
import {
  CALL_SESSION_LEASE_TTL_MS,
  CALL_SESSION_MIRROR_INTERVAL_MS,
  isBillingOwnershipV2Enabled,
  isDurableCallSessionEnabled,
} from './billing-phase-flags';
import { getBillingInstanceId } from './billing-instance-id';
import { recordDualWriteDrift, recordLeaseTakeover, recordStaleFencingReject } from './billing-phase-metrics';
import { logInfo } from '../../utils/logger';
import type { CallSession as RedisCallSession } from './billing.service';

export type ClaimSettlementResult =
  | { ok: true; settlementVersion: number }
  | { ok: false; reason: 'already_finalized' | 'claim_lost' | 'disabled' };

export type PersistGuardContext = {
  instanceId: string;
  reconnectGeneration: number;
  fencingToken: number;
};

function mapSettlementReasonToFinalization(
  reason: string,
  source: string
): FinalizationReason {
  if (source.includes('watchdog') || source.includes('reconciliation')) {
    return 'watchdog_recovery';
  }
  if (reason === 'insufficient_coins') return 'insufficient_balance';
  if (reason === 'disconnect') return 'disconnect_timeout';
  if (reason === 'timeout') return 'disconnect_timeout';
  if (reason === 'force_end') return 'force_terminated';
  return 'normal_end';
}

export async function createDurableCallSessionAtStart(params: {
  callId: string;
  callerId: string;
  creatorId: string;
  callerFirebaseUid: string;
  creatorFirebaseUid: string;
  pricePerMinute?: number;
  pricePerSecondMicros?: number;
  creatorShareAtCallTime?: number;
}): Promise<IDurableCallSession | null> {
  if (!isDurableCallSessionEnabled()) return null;

  const now = new Date();
  const instanceId = getBillingInstanceId();
  const leaseExpiresAt = new Date(now.getTime() + CALL_SESSION_LEASE_TTL_MS);

  const doc = await DurableCallSession.findOneAndUpdate(
    { _id: params.callId },
    {
      $setOnInsert: {
        _id: params.callId,
        callerId: new mongoose.Types.ObjectId(params.callerId),
        creatorId: new mongoose.Types.ObjectId(params.creatorId),
        callerFirebaseUid: params.callerFirebaseUid,
        creatorFirebaseUid: params.creatorFirebaseUid,
        state: 'active' as DurableCallSessionState,
        startedAt: now,
        lastBillingAt: now,
        accumulatedDurationSec: 0,
        totalUserDebitedMicros: 0,
        totalCreatorCreditedMicros: 0,
        billingSequence: 0,
        lastPersistedTickNumber: 0,
        settlementVersion: 0,
        finalized: false,
        serverStartedAt: now,
        lastServerAccrualAt: now,
        fencingToken: 1,
        reconnectGeneration: 0,
        recoveryAttempts: 0,
        pricePerMinute: params.pricePerMinute,
        pricePerSecondMicros: params.pricePerSecondMicros,
        creatorShareAtCallTime: params.creatorShareAtCallTime,
        ...(isBillingOwnershipV2Enabled()
          ? { leaseOwnerId: instanceId, leaseExpiresAt }
          : {}),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  logInfo('durable_call_session_created', {
    callId: params.callId,
    state: doc?.state,
  });

  return doc;
}

export async function getDurableCallSession(callId: string): Promise<IDurableCallSession | null> {
  if (!isDurableCallSessionEnabled()) return null;
  return DurableCallSession.findById(callId);
}

export async function isDurableCallSessionFinalized(callId: string): Promise<boolean> {
  if (!isDurableCallSessionEnabled()) return false;
  const doc = await DurableCallSession.findById(callId).select('finalized state').lean();
  return doc?.finalized === true || doc?.state === 'settled';
}

export async function claimDurableCallSessionForSettlement(params: {
  callId: string;
  reason: string;
  source: string;
}): Promise<ClaimSettlementResult> {
  if (!isDurableCallSessionEnabled()) {
    return { ok: true, settlementVersion: 1 };
  }

  const ownerId = getBillingInstanceId();
  const now = new Date();
  const finalizationReason = mapSettlementReasonToFinalization(params.reason, params.source);

  const result = await DurableCallSession.findOneAndUpdate(
    {
      _id: params.callId,
      finalized: false,
      state: { $in: ['active', 'reconnecting', 'ending'] },
    },
    {
      $set: {
        state: 'settling',
        finalizationReason,
        finalizationOwnerId: ownerId,
        finalizationStartedAt: now,
      },
      $inc: { settlementVersion: 1 },
    },
    { new: true }
  );

  if (!result) {
    const existing = await DurableCallSession.findById(params.callId).lean();
    if (existing?.finalized || existing?.state === 'settled') {
      return { ok: false, reason: 'already_finalized' };
    }
    return { ok: false, reason: 'claim_lost' };
  }

  return { ok: true, settlementVersion: result.settlementVersion };
}

export async function markDurableCallSessionEnding(callId: string, endedAt?: Date): Promise<void> {
  if (!isDurableCallSessionEnabled()) return;

  await DurableCallSession.updateOne(
    { _id: callId, finalized: false, state: { $in: ['active', 'reconnecting'] } },
    {
      $set: {
        state: 'ending',
        endedAt: endedAt ?? new Date(),
      },
    }
  );
}

export async function markDurableCallSessionSettled(params: {
  callId: string;
  settlementVersion: number;
}): Promise<void> {
  if (!isDurableCallSessionEnabled()) return;

  await DurableCallSession.updateOne(
    { _id: params.callId, finalized: false },
    {
      $set: {
        state: 'settled',
        finalized: true,
        finalizedAt: new Date(),
        settlementVersion: params.settlementVersion,
      },
    }
  );
}

export async function markDurableCallSessionFailedSettlement(callId: string): Promise<void> {
  if (!isDurableCallSessionEnabled()) return;

  await DurableCallSession.updateOne(
    { _id: callId, finalized: false },
    { $set: { state: 'failed_settlement' } }
  );
}

export async function mirrorRedisSessionToDurableCallSession(
  callId: string,
  redisSession: RedisCallSession,
  guard?: PersistGuardContext
): Promise<boolean> {
  if (!isDurableCallSessionEnabled()) return true;

  const now = new Date();
  const filter: Record<string, unknown> = { _id: callId, finalized: false };

  if (isBillingOwnershipV2Enabled() && guard) {
    filter.reconnectGeneration = guard.reconnectGeneration;
    filter.fencingToken = guard.fencingToken;
    filter.leaseOwnerId = guard.instanceId;
  }

  const update: Record<string, unknown> = {
    lastBillingAt: now,
    lastServerAccrualAt: now,
    accumulatedDurationSec: Math.max(0, Number(redisSession.elapsedSeconds) || 0),
    totalUserDebitedMicros: Math.max(0, Number(redisSession.totalDeductedMicros) || 0),
    totalCreatorCreditedMicros: Math.max(0, Number(redisSession.totalEarnedMicros) || 0),
    billingSequence: Math.max(0, Number(redisSession.billingSequence) || 0),
  };

  if (isBillingOwnershipV2Enabled()) {
    update.leaseExpiresAt = new Date(now.getTime() + CALL_SESSION_LEASE_TTL_MS);
  }

  const result = await DurableCallSession.updateOne(filter, { $set: update });

  if (result.matchedCount === 0 && isBillingOwnershipV2Enabled() && guard) {
    recordStaleFencingReject(callId, 'mirror_guard_mismatch');
    return false;
  }

  if (result.matchedCount === 0) return false;

  const mongoDoc = await DurableCallSession.findById(callId).lean();
  if (mongoDoc) {
    const deductDrift =
      Math.abs((mongoDoc.totalUserDebitedMicros || 0) - (redisSession.totalDeductedMicros || 0));
    const earnDrift =
      Math.abs((mongoDoc.totalCreatorCreditedMicros || 0) - (redisSession.totalEarnedMicros || 0));
    if (deductDrift > 0) recordDualWriteDrift(callId, 'totalUserDebitedMicros', deductDrift);
    if (earnDrift > 0) recordDualWriteDrift(callId, 'totalCreatorCreditedMicros', earnDrift);
  }

  return true;
}

export async function bumpReconnectGeneration(callId: string): Promise<number | null> {
  if (!isDurableCallSessionEnabled()) return null;

  const inc: Record<string, number> = { reconnectGeneration: 1 };
  if (isBillingOwnershipV2Enabled()) {
    inc.fencingToken = 1;
  }

  const doc = await DurableCallSession.findOneAndUpdate(
    { _id: callId, finalized: false },
    {
      $inc: inc,
      $set: { state: 'reconnecting' },
    },
    { new: true }
  );

  return doc?.reconnectGeneration ?? null;
}

export async function tryTakeoverLease(callId: string, newOwnerId: string): Promise<boolean> {
  if (!isBillingOwnershipV2Enabled()) return false;

  const now = new Date();
  const doc = await DurableCallSession.findOneAndUpdate(
    {
      _id: callId,
      finalized: false,
      leaseExpiresAt: { $lt: now },
    },
    {
      $set: {
        leaseOwnerId: newOwnerId,
        leaseExpiresAt: new Date(now.getTime() + CALL_SESSION_LEASE_TTL_MS),
      },
      $inc: { fencingToken: 1 },
    },
    { new: true }
  );

  if (doc) {
    recordLeaseTakeover(callId, doc.leaseOwnerId || 'unknown');
    return true;
  }
  return false;
}

export async function recordRecoveryAttempt(callId: string, recoveredBy: string): Promise<void> {
  if (!isDurableCallSessionEnabled()) return;

  await DurableCallSession.updateOne(
    { _id: callId },
    {
      $inc: { recoveryAttempts: 1 },
      $set: { recoveredBy, recoveredAt: new Date() },
    }
  );
}

export async function getPersistGuardForCall(callId: string): Promise<PersistGuardContext | null> {
  if (!isBillingOwnershipV2Enabled()) return null;

  const doc = await DurableCallSession.findById(callId)
    .select('reconnectGeneration fencingToken leaseOwnerId')
    .lean();
  if (!doc?.leaseOwnerId) return null;

  return {
    instanceId: doc.leaseOwnerId,
    reconnectGeneration: doc.reconnectGeneration ?? 0,
    fencingToken: doc.fencingToken ?? 1,
  };
}

export async function assignInitialLease(callId: string): Promise<void> {
  if (!isBillingOwnershipV2Enabled() || !isDurableCallSessionEnabled()) return;

  const instanceId = getBillingInstanceId();
  const now = new Date();
  await DurableCallSession.updateOne(
    { _id: callId, finalized: false },
    {
      $set: {
        leaseOwnerId: instanceId,
        leaseExpiresAt: new Date(now.getTime() + CALL_SESSION_LEASE_TTL_MS),
        fencingToken: 1,
      },
    }
  );
}

export async function freezeDurableCallSessionsForShutdown(instanceId: string): Promise<string[]> {
  if (!isDurableCallSessionEnabled()) return [];

  const sessions = await DurableCallSession.find({
    finalized: false,
    state: { $in: ['active', 'reconnecting'] },
    ...(isBillingOwnershipV2Enabled() ? { leaseOwnerId: instanceId } : {}),
  })
    .select('_id')
    .lean();

  const callIds = sessions.map((s) => s._id);

  if (callIds.length > 0) {
    await DurableCallSession.updateMany(
      { _id: { $in: callIds } },
      {
        $set: {
          finalizationReason: 'deployment_shutdown',
        },
        ...(isBillingOwnershipV2Enabled()
          ? { $unset: { leaseOwnerId: '', leaseExpiresAt: '' } }
          : {}),
      }
    );
  }

  return callIds;
}

export function mapSettlementReasonToFinalizationReason(
  reason: string,
  source: string
): FinalizationReason {
  return mapSettlementReasonToFinalization(reason, source);
}

const lastMirrorAtMsByCallId = new Map<string, number>();

export async function maybeMirrorRedisSessionToDurable(
  callId: string,
  redisSession: RedisCallSession,
  options?: { force?: boolean }
): Promise<void> {
  if (!isDurableCallSessionEnabled()) return;

  const now = Date.now();
  if (!options?.force) {
    const last = lastMirrorAtMsByCallId.get(callId) || 0;
    if (now - last < CALL_SESSION_MIRROR_INTERVAL_MS) return;
  }
  lastMirrorAtMsByCallId.set(callId, now);

  let guard: PersistGuardContext | undefined;
  if (isBillingOwnershipV2Enabled()) {
    const existing = await getPersistGuardForCall(callId);
    if (existing && existing.instanceId === getBillingInstanceId()) {
      guard = existing;
    } else if (!existing) {
      await assignInitialLease(callId);
      guard = await getPersistGuardForCall(callId) ?? undefined;
    } else {
      return;
    }
  }

  await mirrorRedisSessionToDurableCallSession(callId, redisSession, guard);
}

export async function flushMirrorRedisSessionToDurable(
  callId: string,
  redisSession: RedisCallSession
): Promise<void> {
  await maybeMirrorRedisSessionToDurable(callId, redisSession, { force: true });
}

export function clearMirrorTracking(callId: string): void {
  lastMirrorAtMsByCallId.delete(callId);
}
