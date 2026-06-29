/**
 * Billing Service — time-diff, integer micro-coins, versioned sessions.
 */

import { randomUUID } from 'crypto';
import { Server } from 'socket.io';
import {
  getRedis,
  callSessionKey,
  callUserCoinsKey,
  callUserIntroMicrosKey,
  callUserWalletMicrosKey,
  callCreatorEarningsKey,
  activeCallByUserKey,
  ACTIVE_CALL_BY_USER_TTL,
  billingStartOrchestratorKey,
  billingStartReplayGuardKey,
  pendingCallEndKey,
  settledCallKey,
} from '../../config/redis';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import {
  MAX_CALL_DURATION_SECONDS,
  DEFAULT_CREATOR_CALL_DURATION_SECONDS,
  DEFAULT_USER_CALL_DURATION_SECONDS,
  CALL_DURATION_WARNING_SECONDS,
  MIN_COINS_TO_CALL,
} from '../../config/pricing.config';
import { getFreeCallDurationSeconds, isFreeCallEnabled } from '../../config/free-call.config';
import { recordBillingMetric, monitoring } from '../../utils/monitoring';
import { logWarning, logInfo, logError, logDebug } from '../../utils/logger';
import { retryWithBackoff } from '../../utils/retry';
import { dlqBillingKey, DLQ_BILLING_TTL } from '../../config/redis';
import { addToDLQSet } from './billing-reconciliation';
import { pricingService } from '../video/pricing.service';
import { Call } from '../video/call.model';
import {
  BILLING_PROCESS_INTERVAL_MS,
  BILLING_SESSION_SCHEMA_VERSION,
  COIN_MICROS,
  MAX_BILLING_DELTA_MS,
  MIN_BILLING_DELTA_MS,
  BILLING_CYCLE_LOCK_TTL_MS,
  BILLING_CYCLE_LOCK_HEARTBEAT_MS,
  coinsWholeToMicros,
  microsToWholeCoinsFloor,
  getBillingCheckpointIntervalMs,
  getBillingCheckpointEverySequences,
  getBillingCheckpointMinDeltaMicros,
  getBillingEmitIntervalMs,
  getBillingRedisBackpressureMs,
  getBillingChainHealStallMs,
  getBillingEmitKeepaliveMs,
} from './billing.constants';
import {
  advanceBillingCheckpointCursor,
  getBillingCheckpoint,
  upsertBillingCheckpoint,
  upsertBillingCheckpointSnapshot,
} from './billing-checkpoint.service';
import { forceTerminateCall } from './billing-termination.service';
import {
  getEmitIntervalForStage,
  getBillingBackpressureStage,
  isNewCallAdmissionBlocked,
  isLiveBillingLifecycle,
  updateBackpressureStage,
} from './billing-backpressure';
import { runsBillingWorkers } from '../../config/service-role';
import { featureFlags } from '../../config/feature-flags';
import {
  BillingLifecycleState,
  transitionBillingState,
  transitionBillingStateWithAudit,
} from './billing-lifecycle.machine';
import { resolveBillingRuntimeState } from './billing-runtime-resolver.service';
import {
  emitBillingStartedFromSnapshot,
  emitBillingUpdateFromSnapshot,
} from './billing-emitter.service';
import { billingInstanceIdsMatch, getBillingInstanceId } from './billing-instance-id';
import {
  createDurableCallSessionAtStart,
  maybeMirrorRedisSessionToDurable,
  flushMirrorRedisSessionToDurable,
} from './call-session.service';
import { isDurableCallSessionEnabled } from './billing-phase-flags';
import { maybePeriodicBillingPersist, flushBillingPersistForCallId } from './billing-persist.service';
import {
  billingHealthFieldsFromSession,
  logBillingHealth,
  logBillingHealthDebug,
  logBillingHealthWarn,
} from './billing-health-log';
import { isNonTerminalLifecycle } from './billing-active-call.service';
import { cancelBillingCycleJob } from './billing.queue';

const CALL_SESSION_TTL = 7200;
const FINAL_FLUSH_MARKER_PREFIX = 'billing:final_flush:';
const FINAL_FLUSH_MARKER_TTL_SECONDS = 24 * 60 * 60;

async function shortCircuitIfTerminalBillingSession(
  redis: ReturnType<typeof getRedis>,
  callId: string,
  lifecycleState: string | undefined
): Promise<BillingTickResult | null> {
  if (!isNonTerminalLifecycle(lifecycleState)) {
    await cancelBillingCycleJob(callId).catch(() => {});
    recordBillingMetric('billing_tick_terminal_short_circuit', 1, {
      callId,
      lifecycleState: lifecycleState ?? 'unknown',
    });
    return 'stop_no_session';
  }
  if (await redis.get(settledCallKey(callId))) {
    await cancelBillingCycleJob(callId).catch(() => {});
    recordBillingMetric('billing_tick_terminal_short_circuit', 1, {
      callId,
      lifecycleState: 'settled_tombstone',
    });
    return 'stop_no_session';
  }
  return null;
}

/** Legacy creator earnings used 1e4 micro-units; convert to COIN_MICROS scale. */
const LEGACY_EARNINGS_MICRO_FACTOR = 10_000;

const BILLING_CYCLE_LOCK_PREFIX = 'billing:cycle_lock:';
const BILLING_RUNTIME_OWNER_LOCK_PREFIX = 'billing:runtime:owner:';
const BILLING_RUNTIME_OWNER_LOCK_TTL_SECONDS = Math.min(
  300,
  Math.max(30, parseInt(process.env.BILLING_RUNTIME_OWNER_LOCK_TTL_SECONDS || '120', 10) || 120)
);
function billingCycleLockKey(callId: string): string {
  return `${BILLING_CYCLE_LOCK_PREFIX}${callId}`;
}
const BILLING_SESSION_START_LOCK_PREFIX = 'billing:start_lock:';
const BILLING_SESSION_START_LOCK_TTL_SECONDS = 30;
const BILLING_START_ORCHESTRATOR_TTL_SECONDS = 20;
const BILLING_START_REPLAY_GUARD_TTL_SECONDS = Math.min(
  120,
  Math.max(5, parseInt(process.env.BILLING_START_REPLAY_GUARD_TTL_SECONDS || '20', 10) || 20)
);
function billingSessionStartLockKey(callId: string): string {
  return `${BILLING_SESSION_START_LOCK_PREFIX}${callId}`;
}

const CALLPAIR_LOCK_PREFIX = 'callpair:';
function callpairKey(uid1: string, uid2: string): string {
  const a = String(uid1 || '');
  const b = String(uid2 || '');
  const [min, max] = a <= b ? [a, b] : [b, a];
  return `${CALLPAIR_LOCK_PREFIX}${min}:${max}`;
}

const RELEASE_BILLING_CYCLE_LOCK_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

async function releaseBillingCycleLock(
  redis: ReturnType<typeof getRedis>,
  lockKey: string,
  token: string
): Promise<void> {
  try {
    await redis.eval(RELEASE_BILLING_CYCLE_LOCK_LUA, 1, lockKey, token);
  } catch {
    /* ignore */
  }
}

function parseRuntimeOwnerLockValue(lockValue: string): { instanceId: string; epoch: number } | null {
  const trimmed = String(lockValue || '').trim();
  if (!trimmed) return null;
  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon <= 0) return null;
  const epoch = parseInt(trimmed.slice(lastColon + 1), 10);
  if (!Number.isFinite(epoch) || epoch < 1) return null;
  return { instanceId: trimmed.slice(0, lastColon), epoch };
}

function billingSequenceStallMs(session: CallSession, nowMs: number): number {
  const lastAdvance = Math.max(
    Number(session.lastSequenceAdvanceAt) || 0,
    Number(session.lastHealthyTickAt) || 0
  );
  if (lastAdvance > 0) {
    return Math.max(0, nowMs - lastAdvance);
  }
  const startTime = Number(session.startTime) || 0;
  if (startTime > 0) {
    return Math.max(0, nowMs - startTime);
  }
  return 0;
}

async function ensureRuntimeOwnership(
  redis: ReturnType<typeof getRedis>,
  session: CallSession,
  callId: string,
  nowMs: number = Date.now()
): Promise<boolean> {
  const { isShuttingDown, assertNotShuttingDown } = await import('./billing-shutdown.service');
  if (isShuttingDown()) {
    return false;
  }
  try {
    assertNotShuttingDown('billing.ownership');
  } catch {
    return false;
  }

  const ownerLockKey = session.leaderLock || `${BILLING_RUNTIME_OWNER_LOCK_PREFIX}${callId}`;
  const runtimeEpoch = Math.max(1, Number(session.runtimeEpoch) || 1);
  const workerInstanceId = getBillingInstanceId();
  const ownerValue = `${workerInstanceId}:${runtimeEpoch}`;
  const existing = await redis.get(ownerLockKey);
  if (!existing) {
    const claimed = await redis.set(
      ownerLockKey,
      ownerValue,
      'EX',
      BILLING_RUNTIME_OWNER_LOCK_TTL_SECONDS,
      'NX'
    );
    if (claimed === 'OK') {
      session.instanceId = workerInstanceId;
      session.runtimeEpoch = runtimeEpoch;
      session.leaderLock = ownerLockKey;
      return true;
    }
  }

  const current = await redis.get(ownerLockKey);
  if (!current) {
    return false;
  }
  if (current !== ownerValue) {
    const stallMs = billingSequenceStallMs(session, nowMs);
    const chainHealStallMs = getBillingChainHealStallMs();
    const parsedOwner = parseRuntimeOwnerLockValue(current);
    const ownerInstanceMismatch =
      parsedOwner != null && !billingInstanceIdsMatch(parsedOwner.instanceId, workerInstanceId);

    if (stallMs > chainHealStallMs || (ownerInstanceMismatch && stallMs > 0)) {
      const nextEpoch = Math.max(runtimeEpoch, (parsedOwner?.epoch ?? runtimeEpoch) + 1);
      await redis.del(ownerLockKey).catch(() => 0);
      session.runtimeEpoch = nextEpoch;
      const takeoverValue = `${workerInstanceId}:${nextEpoch}`;
      const claimed = await redis.set(
        ownerLockKey,
        takeoverValue,
        'EX',
        BILLING_RUNTIME_OWNER_LOCK_TTL_SECONDS,
        'NX'
      );
      if (claimed === 'OK') {
        session.instanceId = workerInstanceId;
        session.leaderLock = ownerLockKey;
        recordBillingMetric('billing_runtime_owner_takeover', 1, {
          callId,
          previousOwner: current,
          workerInstanceId,
          stallMs: String(stallMs),
        });
        logWarning('billing_runtime_owner_takeover', {
          callId,
          previousOwner: current,
          workerInstanceId,
          stallMs,
          nextEpoch,
        });
        return true;
      }
    }

    recordBillingMetric('billing_runtime_epoch_reject_stale_worker', 1, {
      callId,
      currentOwner: current,
      workerInstanceId,
    });
    return false;
  }
  await redis
    .set(ownerLockKey, ownerValue, 'EX', BILLING_RUNTIME_OWNER_LOCK_TTL_SECONDS, 'XX')
    .catch(() => {});
  session.instanceId = workerInstanceId;
  session.runtimeEpoch = runtimeEpoch;
  session.leaderLock = ownerLockKey;
  return true;
}

/**
 * After deploy/restart: reclaim runtime owner lock when it still references a dead process.
 */
export async function reclaimStaleRuntimeOwnershipOnStartup(
  callId: string,
  session: CallSession
): Promise<boolean> {
  const redis = getRedis();
  const ownerLockKey = session.leaderLock || `${BILLING_RUNTIME_OWNER_LOCK_PREFIX}${callId}`;
  const current = await redis.get(ownerLockKey);
  if (!current) {
    return false;
  }
  const parsed = parseRuntimeOwnerLockValue(current);
  const workerInstanceId = getBillingInstanceId();
  if (parsed && billingInstanceIdsMatch(parsed.instanceId, workerInstanceId)) {
    return false;
  }

  const nextEpoch = Math.max(1, Number(session.runtimeEpoch) || 1, (parsed?.epoch ?? 0) + 1);
  await redis.del(ownerLockKey).catch(() => 0);
  session.runtimeEpoch = nextEpoch;
  session.instanceId = workerInstanceId;
  session.leaderLock = ownerLockKey;
  const takeoverValue = `${workerInstanceId}:${nextEpoch}`;
  const claimed = await redis.set(
    ownerLockKey,
    takeoverValue,
    'EX',
    BILLING_RUNTIME_OWNER_LOCK_TTL_SECONDS,
    'NX'
  );
  if (claimed !== 'OK') {
    return false;
  }

  await redis.set(callSessionKey(callId), JSON.stringify(session), 'KEEPTTL').catch(() => {});
  recordBillingMetric('billing_runtime_owner_startup_reclaim', 1, {
    callId,
    previousOwner: current,
    workerInstanceId,
  });
  logInfo('billing_runtime_owner_startup_reclaim', {
    callId,
    previousOwner: current,
    workerInstanceId,
    nextEpoch,
  });

  const { scheduleBillingJob } = await import('./billing.queue');
  await scheduleBillingJob(callId, 0).catch((err) => {
    logError('Startup runtime reclaim schedule failed', err, { callId });
  });
  return true;
}

/** One active billed call per user/creator slot — blocks double session balance snapshots. */
/**
 * If a user/creator slot still references a `callId` with no live billing session, clear it
 * and retry the reservation once (stuck slots after bad settlement / TTL expiry).
 */
async function tryClearOrphanActiveCallSlots(
  redis: ReturnType<typeof getRedis>,
  userFirebaseUid: string,
  creatorFirebaseUid: string
): Promise<void> {
  const clearActiveCallSlot = async (
    key: string,
    roomUid: string,
    reason: 'missing_session' | 'terminal_lifecycle' | 'stale_starting'
  ): Promise<void> => {
    await redis.del(key).catch(() => {});
    const stillExists = Boolean(await redis.get(key));
    logInfo('Active call slot cleanup verification', {
      roomUid,
      slotKey: key,
      reason,
      activeCallKeyDeleted: true,
      activeCallKeyExistsAfterDelete: stillExists,
    });
  };
  for (const [roomUid, key] of [
    [userFirebaseUid, activeCallByUserKey(userFirebaseUid)],
    [creatorFirebaseUid, activeCallByUserKey(creatorFirebaseUid)],
  ] as const) {
    const v = await redis.get(key);
    if (!v) continue;
    const sessionRaw = await redis.get(callSessionKey(String(v)));
    if (!sessionRaw) {
      await clearActiveCallSlot(key, roomUid, 'missing_session');
      recordBillingMetric('session_start_active_slot_orphan_recovered', 1, {
        staleCallId: v,
        roomUid,
      });
      continue;
    }
    try {
      const session = JSON.parse(sessionRaw) as { lifecycleState?: string };
      const lifecycle = String(session.lifecycleState || '').toUpperCase();
      if (lifecycle === 'SETTLED' || lifecycle === 'FAILED') {
        await clearActiveCallSlot(key, roomUid, 'terminal_lifecycle');
        recordBillingMetric('session_start_active_slot_terminal_recovered', 1, {
          staleCallId: v,
          roomUid,
          lifecycle,
        });
      } else if (lifecycle === 'STARTING') {
        const startTime = Number((session as { startTime?: number }).startTime);
        const ageMs = Number.isFinite(startTime) && startTime > 0 ? Math.max(0, Date.now() - startTime) : 0;
        if (ageMs > 120_000) {
          await clearActiveCallSlot(key, roomUid, 'stale_starting');
          recordBillingMetric('session_start_active_slot_starting_recovered', 1, {
            staleCallId: v,
            roomUid,
            lifecycle,
          });
          logWarning('Recovered stale STARTING active call slot', {
            staleCallId: v,
            roomUid,
            ageMs,
          });
        }
      }
    } catch {
      // Preserve slot on parse error; regular reconciliation paths will handle invalid sessions.
    }
  }
}

const RELEASE_CALLPAIR_IF_MATCH_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

async function tryClearStaleCallpairLock(
  redis: ReturnType<typeof getRedis>,
  userFirebaseUid: string,
  creatorFirebaseUid: string
): Promise<{ cleared: boolean; staleCallId?: string; reason?: string }> {
  const pairKey = callpairKey(userFirebaseUid, creatorFirebaseUid);
  const existingCallId = await redis.get(pairKey);
  if (!existingCallId) {
    return { cleared: false };
  }

  const releasePair = async (reason: string): Promise<void> => {
    await redis.eval(RELEASE_CALLPAIR_IF_MATCH_LUA, 1, pairKey, existingCallId).catch(() => {});
    const stillExists = Boolean(await redis.get(pairKey));
    if (stillExists) {
      await redis.del(pairKey).catch(() => {});
    }
    logInfo('Stale callpair lock cleared', {
      pairKey,
      staleCallId: existingCallId,
      reason,
      pairKeyExistsAfterDelete: Boolean(await redis.get(pairKey)),
    });
  };

  const sessionRaw = await redis.get(callSessionKey(existingCallId));
  if (!sessionRaw) {
    await releasePair('missing_session');
    recordBillingMetric('session_start_callpair_orphan_recovered', 1, {
      staleCallId: existingCallId,
    });
    return { cleared: true, staleCallId: existingCallId, reason: 'missing_session' };
  }

  try {
    const session = JSON.parse(sessionRaw) as { lifecycleState?: string; startTime?: number };
    const lifecycle = String(session.lifecycleState || '').toUpperCase();
    if (lifecycle === 'SETTLED' || lifecycle === 'FAILED') {
      await releasePair('terminal_lifecycle');
      recordBillingMetric('session_start_callpair_terminal_recovered', 1, {
        staleCallId: existingCallId,
        lifecycle,
      });
      return { cleared: true, staleCallId: existingCallId, reason: 'terminal_lifecycle' };
    }
    if (lifecycle === 'STARTING') {
      const startTime = Number(session.startTime);
      const ageMs =
        Number.isFinite(startTime) && startTime > 0 ? Math.max(0, Date.now() - startTime) : 0;
      if (ageMs > 120_000) {
        await releasePair('stale_starting');
        recordBillingMetric('session_start_callpair_starting_recovered', 1, {
          staleCallId: existingCallId,
          ageMs: String(ageMs),
        });
        return { cleared: true, staleCallId: existingCallId, reason: 'stale_starting' };
      }
    }
  } catch {
    /* preserve lock on parse error */
  }

  return { cleared: false, staleCallId: existingCallId };
}

async function consumePendingCallEndIfAny(
  io: Server,
  redis: ReturnType<typeof getRedis>,
  callId: string,
  source: string
): Promise<boolean> {
  const key = pendingCallEndKey(callId);
  const pending = await redis.get(key);
  if (!pending) {
    return false;
  }
  let deferredAgeMs = 0;
  try {
    const parsed = JSON.parse(pending) as { requestedAtMs?: number } | null;
    const requestedAtMs = Number(parsed?.requestedAtMs);
    if (Number.isFinite(requestedAtMs) && requestedAtMs > 0) {
      deferredAgeMs = Math.max(0, Date.now() - requestedAtMs);
    }
  } catch {
    // Legacy payloads used a plain sentinel value.
  }
  await redis.del(key).catch(() => {});
  const { finalizeCallEnd } = await import('../video/call-finalization.service');
  await finalizeCallEnd(io, callId, 'deferred_pending_end');
  logInfo('Deferred settlement for call after session promotion', {
    callId,
    source,
    deferredAgeMs,
  });
  recordBillingMetric('deferred_call_end_age_ms', deferredAgeMs, {
    callId,
    source,
  });
  recordBillingMetric('deferred_call_end_age', deferredAgeMs, {
    callId,
    source,
  });
  recordBillingMetric('deferred_call_end_flushed', 1, {
    callId,
    source,
  });
  if (deferredAgeMs > 5000) {
    recordBillingMetric('deferred_call_end_slow_flush', 1, {
      callId,
      source,
      deferredAgeMs: String(deferredAgeMs),
    });
  }
  return true;
}

async function waitForSessionSnapshot(
  redis: ReturnType<typeof getRedis>,
  callId: string,
  opts?: { timeoutMs?: number; intervalMs?: number }
): Promise<CallSession | null> {
  const timeoutMs = Math.max(100, opts?.timeoutMs ?? 2000);
  const intervalMs = Math.max(25, opts?.intervalMs ?? 100);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const raw = await redis.get(callSessionKey(callId));
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as CallSession;
        return parsed;
      } catch {
        // Keep polling for a valid session payload.
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

/** Poll Redis until a billing session snapshot exists (used before deferring call:ended). */
export async function waitForBillingSessionReady(
  callId: string,
  opts?: { timeoutMs?: number; intervalMs?: number }
): Promise<CallSession | null> {
  return waitForSessionSnapshot(getRedis(), callId, opts);
}

async function tryReserveActiveCallSlotsWithOrphanRetry(
  redis: ReturnType<typeof getRedis>,
  callId: string,
  userFirebaseUid: string,
  creatorFirebaseUid: string
): Promise<'ok' | 'conflict'> {
  let r = await tryReserveActiveCallSlots(redis, callId, userFirebaseUid, creatorFirebaseUid);
  if (r === 'ok') return 'ok';
  await tryClearOrphanActiveCallSlots(redis, userFirebaseUid, creatorFirebaseUid);
  r = await tryReserveActiveCallSlots(redis, callId, userFirebaseUid, creatorFirebaseUid);
  return r;
}

async function tryReserveActiveCallSlots(
  redis: ReturnType<typeof getRedis>,
  callId: string,
  userFirebaseUid: string,
  creatorFirebaseUid: string
): Promise<'ok' | 'conflict'> {
  const userKey = activeCallByUserKey(userFirebaseUid);
  const creatorKey = activeCallByUserKey(creatorFirebaseUid);
  const reserveLua = `
local userExisting = redis.call("GET", KEYS[1])
if userExisting and userExisting ~= ARGV[1] then
  return "conflict"
end
local creatorExisting = redis.call("GET", KEYS[2])
if creatorExisting and creatorExisting ~= ARGV[1] then
  return "conflict"
end
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
redis.call("SET", KEYS[2], ARGV[1], "EX", ARGV[2])
return "ok"
`;
  const result = await redis.eval(
    reserveLua,
    2,
    userKey,
    creatorKey,
    callId,
    String(ACTIVE_CALL_BY_USER_TTL)
  );
  return result === 'ok' ? 'ok' : 'conflict';
}

export async function releaseActiveCallSlotsIfOurs(
  redis: ReturnType<typeof getRedis>,
  callId: string,
  userFirebaseUid: string,
  creatorFirebaseUid: string
): Promise<void> {
  const userKey = activeCallByUserKey(userFirebaseUid);
  const creatorKey = activeCallByUserKey(creatorFirebaseUid);
  const [u, c] = await Promise.all([redis.get(userKey), redis.get(creatorKey)]);
  if (u === callId) {
    await redis.del(userKey).catch(() => {});
    const keyStillExists = Boolean(await redis.get(userKey));
    logInfo('Released active call slot for payer', {
      callId,
      firebaseUid: userFirebaseUid,
      activeCallKeyDeleted: true,
      activeCallKeyExistsAfterDelete: keyStillExists,
    });
  }
  if (c === callId) {
    await redis.del(creatorKey).catch(() => {});
    const keyStillExists = Boolean(await redis.get(creatorKey));
    logInfo('Released active call slot for creator', {
      callId,
      firebaseUid: creatorFirebaseUid,
      activeCallKeyDeleted: true,
      activeCallKeyExistsAfterDelete: keyStillExists,
    });
  }
}

async function releaseActiveCallSlotsIfTerminal(
  redis: ReturnType<typeof getRedis>,
  session: Pick<CallSession, 'callId' | 'userFirebaseUid' | 'creatorFirebaseUid' | 'lifecycleState'>
): Promise<void> {
  const lifecycle = String(session.lifecycleState || '');
  if (lifecycle !== 'SETTLED' && lifecycle !== 'FAILED') {
    return;
  }
  await releaseActiveCallSlotsIfOurs(
    redis,
    session.callId,
    session.userFirebaseUid,
    session.creatorFirebaseUid
  );
}

async function persistCallSession(
  redis: ReturnType<typeof getRedis>,
  callId: string,
  session: CallSession
): Promise<void> {
  await redis.setex(callSessionKey(callId), CALL_SESSION_TTL, JSON.stringify(session));
  await releaseActiveCallSlotsIfTerminal(redis, session);
}

async function refreshActiveCallSlotsTtl(
  redis: ReturnType<typeof getRedis>,
  userFirebaseUid: string,
  creatorFirebaseUid: string
): Promise<void> {
  await Promise.all([
    redis.expire(activeCallByUserKey(userFirebaseUid), ACTIVE_CALL_BY_USER_TTL),
    redis.expire(activeCallByUserKey(creatorFirebaseUid), ACTIVE_CALL_BY_USER_TTL),
    // Keep pair lock alive during active billing.
    redis.expire(callpairKey(userFirebaseUid, creatorFirebaseUid), CALL_SESSION_TTL),
  ]);
}

export function needsFullSessionBootstrap(session: Partial<CallSession>): boolean {
  const version = Number(session.version ?? 0);
  return (
    version <= 0 ||
    !String(session.userMongoId || '').trim() ||
    !String(session.creatorMongoId || '').trim()
  );
}

export function isBootstrappingSession(session: Partial<CallSession>): boolean {
  const ppsMicros = Number(
    session.billingPricePerSecondMicros ?? session.pricePerSecondMicros ?? 0
  );
  return needsFullSessionBootstrap(session) || ppsMicros <= 0;
}

export type PromoteBootstrapResult =
  | {
      ok: true;
      session: CallSession;
      spendableMicros: number;
      initialIntroMicros: number;
      initialWalletMicros: number;
      introPromoActive: boolean;
      pricePerSecondMicros: number;
      creatorEarningsPerSecondMicros: number;
    }
  | {
      ok: false;
      reason:
        | 'user_not_found'
        | 'creator_not_found'
        | 'invalid_participants'
        | 'insufficient_coins'
        | 'concurrent_promote'
        | 'redis_error';
    };

export async function promoteBootstrappingSession(
  io: Server,
  redis: ReturnType<typeof getRedis>,
  callId: string,
  existingSession: CallSession,
  source: string,
  opts?: {
    terminateOnFailure?: boolean;
    preserveStartTime?: boolean;
    preserveRuntimeBalances?: boolean;
    initiatedByFirebaseUid?: string;
    initiatedByRole?: 'user' | 'creator' | 'admin';
    seedStartTime?: number;
  }
): Promise<PromoteBootstrapResult> {
  const userFirebaseUid = existingSession.userFirebaseUid;
  const creatorFirebaseUid = existingSession.creatorFirebaseUid;
  const creatorMongoId = String(existingSession.creatorMongoId || '').trim();
  const initiatedByFirebaseUid = opts?.initiatedByFirebaseUid ?? existingSession.initiatedByFirebaseUid;
  const initiatedByRole = opts?.initiatedByRole ?? existingSession.initiatedByRole;
  const terminateOnFailure = opts?.terminateOnFailure === true;

  const liveRaw = await redis.get(callSessionKey(callId));
  if (liveRaw) {
    try {
      const live = JSON.parse(liveRaw) as CallSession;
      if (!isBootstrappingSession(live)) {
        return { ok: false, reason: 'concurrent_promote' };
      }
    } catch {
      /* proceed with promotion attempt */
    }
  }

  let user = await User.findOne({ firebaseUid: userFirebaseUid });
  if (!user) {
    const userMongoId = String(existingSession.userMongoId || '').trim();
    if (userMongoId) {
      user = await User.findById(userMongoId);
    }
  }
  if (!user) {
    return { ok: false, reason: 'user_not_found' };
  }
  if (user.role !== 'user') {
    if (terminateOnFailure) {
      await releaseActiveCallSlotsIfOurs(redis, callId, userFirebaseUid, creatorFirebaseUid);
      void forceTerminateCall(io, {
        callId,
        userFirebaseUid,
        creatorFirebaseUid,
        reason: 'unknown',
        creatorReason: 'unknown',
        userPayload: { message: 'Invalid call participants.' },
      }).catch(() => {});
    }
    return { ok: false, reason: 'invalid_participants' };
  }

  let creator = creatorMongoId ? await Creator.findById(creatorMongoId) : null;
  if (!creator && creatorMongoId) {
    creator = await Creator.findOne({ userId: creatorMongoId });
  }
  if (!creator) {
    return { ok: false, reason: 'creator_not_found' };
  }

  const creatorUser = await User.findById(creator.userId).select('firebaseUid role').lean();
  const creatorUserFirebaseUid = creatorUser?.firebaseUid || '';
  const creatorUserRole = creatorUser?.role || null;
  const creatorRoleOk = creatorUserRole === 'creator' || creatorUserRole === 'admin';
  if (!creatorRoleOk || !creatorUserFirebaseUid || creatorUserFirebaseUid !== creatorFirebaseUid) {
    if (terminateOnFailure) {
      await releaseActiveCallSlotsIfOurs(redis, callId, userFirebaseUid, creatorFirebaseUid);
      void forceTerminateCall(io, {
        callId,
        userFirebaseUid,
        creatorFirebaseUid,
        reason: 'unknown',
        creatorReason: 'unknown',
        userPayload: { message: 'Invalid call participants.' },
      }).catch(() => {});
      recordBillingMetric('session_start_invalid_participants', 1, {
        callIdPrefix: callId.length > 16 ? callId.slice(0, 16) : callId,
        source,
      });
    }
    return { ok: false, reason: 'invalid_participants' };
  }

  const pricing = pricingService.snapshotFromLoadedCreator(creator);
  void pricingService.warmSnapshotCache(creator._id.toString(), pricing);
  const pricePerSecondMicros = pricing.pricePerSecondMicros;
  const creatorEarningsPerSecondMicros = pricing.creatorEarningsPerSecondMicros;

  const introCreditsLive = Number((user as { introFreeCallCredits?: number }).introFreeCallCredits) || 0;
  const consumedAt = (user as { welcomeFreeCallConsumedAt?: Date | null }).welcomeFreeCallConsumedAt;
  let introPromoActive =
    isFreeCallEnabled() &&
    user.role === 'user' &&
    !consumedAt &&
    introCreditsLive > 0;
  const freeCallDurationSeconds = getFreeCallDurationSeconds();
  let initialIntroMicros =
    introPromoActive && pricePerSecondMicros > 0
      ? freeCallDurationSeconds * pricePerSecondMicros
      : 0;
  let initialWalletMicros = introPromoActive ? 0 : coinsWholeToMicros(user.coins || 0);

  const hasRuntimeActivity =
    Number(existingSession.billingSequence ?? 0) > 0 ||
    Number(existingSession.totalDeductedMicros ?? 0) > 0;
  const repairPreserveRequested = opts?.preserveRuntimeBalances === true;
  const preserveRuntimeBalances =
    repairPreserveRequested ||
    (opts?.preserveStartTime === true && hasRuntimeActivity);

  type BalanceSource = 'mongo' | 'redis_runtime';
  let balanceSource: BalanceSource = 'mongo';

  if (preserveRuntimeBalances) {
    const [introRaw, walletRaw] = await Promise.all([
      redis.get(callUserIntroMicrosKey(callId)),
      redis.get(callUserWalletMicrosKey(callId)),
    ]);
    const redisIntro =
      introRaw !== null ? Math.max(0, parseInt(String(introRaw), 10) || 0) : null;
    const redisWallet =
      walletRaw !== null ? Math.max(0, parseInt(String(walletRaw), 10) || 0) : null;
    const redisTotal = (redisIntro ?? 0) + (redisWallet ?? 0);
    const canUseRedisRuntime =
      hasRuntimeActivity && redisTotal > 0 && (introRaw !== null || walletRaw !== null);

    if (canUseRedisRuntime) {
      initialIntroMicros = redisIntro ?? 0;
      initialWalletMicros = redisWallet ?? 0;
      introPromoActive =
        existingSession.introPromoActive === true ||
        (initialIntroMicros > 0 && initialWalletMicros === 0);
      balanceSource = 'redis_runtime';
    } else {
      logDebug('billing_promote_balance_from_mongo', {
        callId,
        source,
        repairPreserveRequested,
        hasRuntimeActivity,
        redisIntroMicros: redisIntro,
        redisWalletMicros: redisWallet,
        mongoIntroMicros: initialIntroMicros,
        mongoWalletMicros: initialWalletMicros,
      });
    }
  }

  const spendableMicros = initialIntroMicros + initialWalletMicros;
  const minEntryMicros = coinsWholeToMicros(MIN_COINS_TO_CALL);
  if (
    !preserveRuntimeBalances &&
    spendableMicros < Math.max(pricePerSecondMicros, minEntryMicros)
  ) {
    if (terminateOnFailure) {
      await releaseActiveCallSlotsIfOurs(redis, callId, userFirebaseUid, creatorFirebaseUid);
      void forceTerminateCall(io, {
        callId,
        userFirebaseUid,
        creatorFirebaseUid,
        reason: spendableMicros < minEntryMicros ? 'min_coins_not_met' : 'insufficient_coins',
        creatorReason: 'user_out_of_coins',
        userPayload: {
          remainingCoins: microsToWholeCoinsFloor(spendableMicros),
          minCoinsRequired: MIN_COINS_TO_CALL,
        },
      }).catch((err) => {
        logError('Failed to trigger force termination at call start', err, {
          callId,
          userFirebaseUid,
        });
      });
    }
    return { ok: false, reason: 'insufficient_coins' };
  }

  const creatorLimit =
    (creator as { maxCallDurationSeconds?: number }).maxCallDurationSeconds ??
    DEFAULT_CREATOR_CALL_DURATION_SECONDS;
  const userLimit =
    (user as { maxCallDurationSeconds?: number }).maxCallDurationSeconds ??
    DEFAULT_USER_CALL_DURATION_SECONDS;
  const platformCapSeconds = Math.min(creatorLimit, userLimit, MAX_CALL_DURATION_SECONDS);
  let effectiveDurationLimitSeconds = platformCapSeconds;
  if (introPromoActive && pricePerSecondMicros > 0) {
    effectiveDurationLimitSeconds = Math.min(
      platformCapSeconds,
      freeCallDurationSeconds,
    );
  }

  const startTime =
    opts?.preserveStartTime === true
      ? Number(existingSession.startTime) || Date.now()
      : Date.now();
  const session: CallSession = {
    ...existingSession,
    schemaVersion: BILLING_SESSION_SCHEMA_VERSION,
    billingVersion: 1,
    initialIntroMicros,
    initialWalletMicros,
    billingPricePerSecondMicros: pricePerSecondMicros,
    introPromoActive,
    introPromoSessionId: callId,
    totalIntroDeductedMicros: existingSession.totalIntroDeductedMicros ?? 0,
    totalWalletDeductedMicros: existingSession.totalWalletDeductedMicros ?? 0,
    callId,
    userFirebaseUid,
    creatorFirebaseUid,
    userMongoId: user._id.toString(),
    creatorMongoId: creator._id.toString(),
    initiatedByFirebaseUid,
    initiatedByRole,
    pricePerMinute: pricing.pricePerMinute,
    pricePerSecondMicros,
    creatorEarningsPerSecondMicros,
    creatorShareAtCallTime: pricing.creatorShareAtCallTime,
    startTime,
    lastProcessedAt: startTime,
    version: 1,
    billingSequence: existingSession.billingSequence ?? 0,
    lifecycleState: existingSession.lifecycleState ?? 'STARTING',
    totalDeductedMicros: existingSession.totalDeductedMicros ?? 0,
    totalEarnedMicros: existingSession.totalEarnedMicros ?? 0,
    elapsedSeconds: existingSession.elapsedSeconds ?? 0,
    effectiveDurationLimitSeconds,
    lastCheckpointAtMs: existingSession.lastCheckpointAtMs ?? 0,
    lastHealthyTickAt: existingSession.lastHealthyTickAt ?? startTime,
    lastSocketEmitAt: existingSession.lastSocketEmitAt ?? startTime,
    lastSequenceAdvanceAt: existingSession.lastSequenceAdvanceAt ?? startTime,
    expectedNextTickAtMs: startTime + BILLING_PROCESS_INTERVAL_MS,
    instanceId: existingSession.instanceId ?? getBillingInstanceId(),
    runtimeEpoch: existingSession.runtimeEpoch ?? 1,
    leaderLock: existingSession.leaderLock ?? `runtime:${callId}`,
  };
  normalizeV4SessionFields(session);

  void Call.updateOne(
    { callId },
    {
      $setOnInsert: {
        callId,
        callerUserId: user._id,
        creatorUserId: creator.userId,
        status: 'ringing',
      },
      ...(initiatedByFirebaseUid ? { $set: { initiatedByFirebaseUid } } : {}),
      ...(initiatedByRole ? { $set: { initiatedByRole } } : {}),
    },
    { upsert: true }
  ).catch(() => {});

  try {
    recordBillingMetric('redis_ops', 5, { callId, path: 'session_seed' });
    const writeRuntimeBalanceKeys = balanceSource !== 'redis_runtime';
    if (writeRuntimeBalanceKeys) {
      await redis
        .multi()
        .setex(callSessionKey(callId), CALL_SESSION_TTL, JSON.stringify(session))
        .setex(callUserIntroMicrosKey(callId), CALL_SESSION_TTL, String(initialIntroMicros))
        .setex(callUserWalletMicrosKey(callId), CALL_SESSION_TTL, String(initialWalletMicros))
        .setex(callCreatorEarningsKey(callId), CALL_SESSION_TTL, '0')
        .exec();
    } else {
      await redis.setex(callSessionKey(callId), CALL_SESSION_TTL, JSON.stringify(session));
    }
    logInfo('billing_session_promoted_full', {
      ...billingLifecycleLogContext({
        callId,
        source,
        payerFirebaseUid: userFirebaseUid,
        creatorFirebaseUid,
        initiatedByFirebaseUid,
        initiatedByRole,
      }),
      promotedDelayMs: Math.max(0, Date.now() - (opts?.seedStartTime ?? startTime)),
    });
    recordBillingMetric('redis_pipeline_success', 1, { callId, path: 'session_seed' });

    try {
      await upsertBillingCheckpointSnapshot({
        callId,
        userMongoId: session.userMongoId,
        creatorMongoId: session.creatorMongoId,
        userFirebaseUid: session.userFirebaseUid,
        creatorFirebaseUid: session.creatorFirebaseUid,
        startTimeMs: session.startTime,
        lastProcessedAtMs: session.lastProcessedAt,
        remainingUserBalanceMicros: spendableMicros,
        pricePerSecondMicros: session.pricePerSecondMicros,
        creatorEarningsPerSecondMicros: session.creatorEarningsPerSecondMicros,
        totalDeductedMicros: session.totalDeductedMicros,
        totalEarnedMicros: session.totalEarnedMicros,
        billingSequence: session.billingSequence,
        lifecycleState: session.lifecycleState,
        status: 'active',
      });
    } catch (cpErr) {
      logError('Early checkpoint snapshot after session seed failed (non-fatal)', cpErr, {
        callId,
      });
    }
  } catch (redisError) {
    recordBillingMetric('redis_pipeline_failure', 1, { callId, path: 'session_seed' });
    logError('CRITICAL: Failed to promote bootstrapping billing session in Redis', redisError, {
      callId,
      source,
      alert: true,
    });
    return { ok: false, reason: 'redis_error' };
  }

  return {
    ok: true,
    session,
    spendableMicros,
    initialIntroMicros,
    initialWalletMicros,
    introPromoActive,
    pricePerSecondMicros,
    creatorEarningsPerSecondMicros,
  };
}

async function clearCallSessionSeed(
  redis: ReturnType<typeof getRedis>,
  callId: string
): Promise<void> {
  await redis
    .multi()
    .del(callSessionKey(callId))
    .del(callUserIntroMicrosKey(callId))
    .del(callUserWalletMicrosKey(callId))
    .del(callCreatorEarningsKey(callId))
    .del(callUserCoinsKey(callId))
    .exec();
}

/** Max flush iterations before settlement (covers worst-case wall lag vs MAX_BILLING_DELTA_MS). */
export const MAX_SETTLEMENT_FLUSH_ITERATIONS = 50;

export function finalFlushMarkerKey(callId: string): string {
  return `${FINAL_FLUSH_MARKER_PREFIX}${callId}`;
}

export async function getBillingWallLagMs(callId: string): Promise<number | null> {
  const redis = getRedis();
  const sessionRaw = await redis.get(callSessionKey(callId));
  if (!sessionRaw) return null;
  try {
    const parsed = JSON.parse(sessionRaw) as { lastProcessedAt?: number };
    const lp = Number(parsed.lastProcessedAt);
    if (!Number.isFinite(lp)) return null;
    return Math.max(0, Date.now() - lp);
  } catch {
    return null;
  }
}

export type BillingTickResult =
  | 'tick_ok'
  | 'tick_deferred'
  | 'stop_no_session'
  | 'stop_needs_settlement';

export interface CallSession {
  schemaVersion: number;
  billingVersion?: number;
  /** Snapshot at billing start — never overwritten mid-call */
  initialIntroMicros?: number;
  initialWalletMicros?: number;
  /** Frozen rate for this session (equals pricePerSecondMicros at start) */
  billingPricePerSecondMicros?: number;
  introPromoActive?: boolean;
  introPromoSessionId?: string;
  totalIntroDeductedMicros?: number;
  totalWalletDeductedMicros?: number;
  callId: string;
  userFirebaseUid: string;
  creatorFirebaseUid: string;
  userMongoId: string;
  creatorMongoId: string;
  initiatedByFirebaseUid?: string;
  initiatedByRole?: 'user' | 'creator' | 'admin';
  pricePerMinute: number;
  /** Integer micro-coins charged from user per second */
  pricePerSecondMicros: number;
  /** Integer micro-coins to creator per second */
  creatorEarningsPerSecondMicros: number;
  creatorShareAtCallTime: number;
  startTime: number;
  lastProcessedAt: number;
  version: number;
  billingSequence: number;
  lifecycleState: BillingLifecycleState;
  totalDeductedMicros: number;
  totalEarnedMicros: number;
  elapsedSeconds: number;
  effectiveDurationLimitSeconds: number;
  /** Last Mongo checkpoint time (ms); optional */
  lastCheckpointAtMs?: number;
  /** Totals at last successful checkpoint upsert (micros); for adaptive checkpoint gating */
  lastCheckpointDeductedMicros?: number;
  lastCheckpointEarnedMicros?: number;
  /** Last server emit timestamp for throttling high-frequency billing:update fanout. */
  lastEmitAtMs?: number;
  /** Heartbeat timestamps consumed by watchdog heuristics. */
  lastHealthyTickAt?: number;
  lastSocketEmitAt?: number;
  lastSequenceAdvanceAt?: number;
  /** Expected next tick time for drift telemetry. */
  expectedNextTickAtMs?: number;
  /** Deployment-safe runtime ownership metadata. */
  instanceId?: string;
  runtimeEpoch?: number;
  leaderLock?: string;
  /** @deprecated migrated from v1 */
  pricePerSecond?: number;
  creatorEarningsPerSecond?: number;
}

function emitSoon(fn: () => void): void {
  setImmediate(() => {
    try {
      fn();
    } catch (e) {
      logError('billing emitSoon failed', e, {});
    }
  });
}

export async function maybeEmitBillingKeepaliveIfDue(
  io: Server,
  redis: ReturnType<typeof getRedis>,
  callId: string,
  session: CallSession,
  balanceMicros: number,
  introPromoBilling: boolean,
  earningsMicros: number,
  trigger: 'short_delta' | 'zero_deduct' | 'recovery'
): Promise<boolean> {
  const lifecycle = String(session.lifecycleState || '');
  if (lifecycle !== 'ACTIVE' && lifecycle !== 'RECOVERING' && lifecycle !== 'STARTING') {
    return false;
  }

  const pricePerSecondMicros =
    session.billingPricePerSecondMicros ?? session.pricePerSecondMicros;
  const emitIntervalMs = getEmitIntervalForStage(getBillingEmitIntervalMs());
  const keepaliveIntervalMs = Math.max(emitIntervalMs, getBillingEmitKeepaliveMs());
  const nowMs = Date.now();
  const lastEmit = Number(session.lastEmitAtMs ?? session.lastSocketEmitAt) || 0;
  const emitStallMs = lastEmit > 0 ? Math.max(0, nowMs - lastEmit) : keepaliveIntervalMs;
  if (emitStallMs < keepaliveIntervalMs) {
    return false;
  }

  const effectiveLimit = session.effectiveDurationLimitSeconds;
  const remainingSeconds =
    pricePerSecondMicros > 0 ? Math.floor(balanceMicros / pricePerSecondMicros) : 0;
  const roundedEarningsDisplay = Math.round((earningsMicros / COIN_MICROS) * 100) / 100;
  const serverTimestamp = nowMs;

  session.lastEmitAtMs = nowMs;
  session.lastSocketEmitAt = nowMs;
  recordBillingMetric('emit_update_keepalive', 1, { callId, trigger });
  logBillingHealth('EMIT_KEEPALIVE', {
    ...billingHealthFieldsFromSession(session),
    trigger,
    emitStallMs,
  });
  await persistCallSession(redis, callId, session);
  await refreshActiveCallSlotsTtl(redis, session.userFirebaseUid, session.creatorFirebaseUid);
  emitSoon(() => {
    emitBillingUpdateFromSnapshot(
      io,
      session.userFirebaseUid,
      session.creatorFirebaseUid,
      {
        callId,
        billingSequence: session.billingSequence,
        lifecycleState: session.lifecycleState,
        coins: microsToWholeCoinsFloor(balanceMicros),
        coinsExact: balanceMicros / COIN_MICROS,
        elapsedSeconds: session.elapsedSeconds,
        remainingSeconds,
        durationLimit: effectiveLimit,
        serverTimestamp,
        callStartTime: session.startTime,
        introPromoActive: introPromoBilling,
        pricePerSecondMicros: session.pricePerSecondMicros,
      },
      {
        callId,
        billingSequence: session.billingSequence,
        lifecycleState: session.lifecycleState,
        earnings: roundedEarningsDisplay,
        elapsedSeconds: session.elapsedSeconds,
        durationLimit: effectiveLimit,
        serverTimestamp,
        callStartTime: session.startTime,
        pricePerSecondMicros: session.creatorEarningsPerSecondMicros,
      }
    );
  });
  return true;
}

export function normalizeV4SessionFields(session: CallSession): void {
  session.billingVersion = session.billingVersion ?? 1;
  session.introPromoActive = session.introPromoActive ?? false;
  session.introPromoSessionId = session.introPromoSessionId ?? session.callId;
  session.initialIntroMicros = session.initialIntroMicros ?? 0;
  session.initialWalletMicros = session.initialWalletMicros ?? 0;
  session.billingPricePerSecondMicros =
    session.billingPricePerSecondMicros ?? session.pricePerSecondMicros;
  session.totalIntroDeductedMicros = session.totalIntroDeductedMicros ?? 0;
  session.totalWalletDeductedMicros = session.totalWalletDeductedMicros ?? 0;
  session.billingSequence = Math.max(0, Number(session.billingSequence ?? 0));
  session['lifecycleState'] = (session.lifecycleState ?? 'INIT') as BillingLifecycleState;
  if (session.lifecycleState === 'INIT' && (session.elapsedSeconds ?? 0) > 0) {
    const transitioned = transitionBillingState({
      callId: session.callId || 'unknown',
      from: session.lifecycleState,
      to: 'ACTIVE',
      source: 'billing.normalizeV4SessionFields',
      reason: 'legacy_elapsed_seconds_backfill',
    });
    session['lifecycleState'] = transitioned.next;
  }
}

export type BillingStartedUserPayload = {
  callId: string;
  billingSequence: number;
  lifecycleState: BillingLifecycleState;
  coins: number;
  introCreditsRemainingApprox: number;
  introPromoActive: boolean;
  pricePerSecond: number;
  pricePerSecondMicros: number;
  maxSeconds: number | undefined;
  elapsedSeconds: number;
  remainingSeconds: number;
  serverTimestamp: number;
  callStartTime: number;
  durationLimit: number | undefined;
};

type BillingLifecycleLogContext = {
  callId: string;
  source?: string;
  payerFirebaseUid?: string;
  creatorFirebaseUid?: string;
  initiatedByFirebaseUid?: string;
  initiatedByRole?: 'user' | 'creator' | 'admin';
  startCorrelationId?: string;
  startIngress?: string;
};

function billingLifecycleLogContext(ctx: BillingLifecycleLogContext): Record<string, unknown> {
  return {
    callId: ctx.callId,
    source: ctx.source,
    payerFirebaseUid: ctx.payerFirebaseUid,
    creatorFirebaseUid: ctx.creatorFirebaseUid,
    initiatedByFirebaseUid: ctx.initiatedByFirebaseUid,
    initiatedByRole: ctx.initiatedByRole,
    startCorrelationId: ctx.startCorrelationId,
    startIngress: ctx.startIngress,
  };
}

async function readLiveUserSpendBalancesMicros(
  redis: ReturnType<typeof getRedis>,
  callId: string
): Promise<{ introMicros: number; walletMicros: number; balanceMicros: number }> {
  const [introR, walletR, legacyMerged] = await Promise.all([
    redis.get(callUserIntroMicrosKey(callId)),
    redis.get(callUserWalletMicrosKey(callId)),
    redis.get(callUserCoinsKey(callId)),
  ]);

  let introMicros = Math.max(0, parseInt(String(introR ?? '0'), 10) || 0);
  let walletMicros = Math.max(0, parseInt(String(walletR ?? '0'), 10) || 0);
  if (introR === null && walletR === null && legacyMerged !== null && legacyMerged !== undefined) {
    walletMicros = Math.max(0, parseInt(String(legacyMerged), 10) || 0);
    introMicros = 0;
  }

  return {
    introMicros,
    walletMicros,
    balanceMicros: introMicros + walletMicros,
  };
}

export async function buildBillingStartedUserPayload(
  redis: ReturnType<typeof getRedis>,
  callId: string,
  session: CallSession
): Promise<BillingStartedUserPayload> {
  const { introMicros, balanceMicros } = await readLiveUserSpendBalancesMicros(redis, callId);
  const pps =
    session.billingPricePerSecondMicros ??
    session.pricePerSecondMicros ??
    Math.max(0, Math.round((session.pricePerSecond ?? 0) * COIN_MICROS));
  const pricePerSecondMicros = Number(pps) || 0;
  const remainingSeconds =
    pricePerSecondMicros > 0 ? Math.floor(balanceMicros / pricePerSecondMicros) : 0;
  const introPromo = session.introPromoActive === true;
  const serverTimestamp = Date.now();

  return {
    callId,
    billingSequence: session.billingSequence ?? 0,
    lifecycleState: session.lifecycleState ?? 'INIT',
    coins: microsToWholeCoinsFloor(balanceMicros),
    introCreditsRemainingApprox: introPromo ? microsToWholeCoinsFloor(introMicros) : 0,
    introPromoActive: introPromo,
    pricePerSecond: pricePerSecondMicros / COIN_MICROS,
    pricePerSecondMicros,
    maxSeconds: session.effectiveDurationLimitSeconds,
    elapsedSeconds: session.elapsedSeconds ?? 0,
    remainingSeconds,
    serverTimestamp,
    callStartTime: session.startTime,
    durationLimit: session.effectiveDurationLimitSeconds,
  };
}

/** REST fallback: return the same shape as `billing:started` when the socket missed the emit. */
export async function getBillingStartedUserPayloadForCall(
  callId: string
): Promise<BillingStartedUserPayload | null> {
  const redis = getRedis();
  const resolved = await resolveBillingRuntimeState(callId);
  if (!resolved.session) return null;
  const session = resolved.session as CallSession;
  normalizeV4SessionFields(session);
  return await buildBillingStartedUserPayload(redis, callId, session);
}

/**
 * When `call:started` races or retries after Redis already has the session, the first
 * `billing:started` may have been missed (socket reconnect). Replay the same event shape
 * from live Redis balances so clients do not sit in "billing sync" until the stuck watchdog.
 */
async function replayBillingStartedFromRedisSession(
  io: Server,
  redis: ReturnType<typeof getRedis>,
  callId: string,
  session: CallSession,
  source: BillingSessionStartSource,
  meta?: {
    startCorrelationId?: string;
    startIngress?: string;
    replayReason?: string;
  }
): Promise<void> {
  const userFirebaseUid = session.userFirebaseUid;
  const creatorFirebaseUid = session.creatorFirebaseUid;

  const userPayload = await buildBillingStartedUserPayload(redis, callId, session);
  const nextTuple = {
    billingSequence: Number(userPayload.billingSequence) || 0,
    serverTimestamp: Number(userPayload.serverTimestamp) || 0,
    callStartTime: Number(userPayload.callStartTime) || 0,
    lifecycleState: String(userPayload.lifecycleState || 'INIT'),
  };
  const monotonicKey = `billing:emit_tuple:last:${callId}`;
  const prevTupleRaw = await redis.get(monotonicKey);
  if (prevTupleRaw) {
    try {
      const prev = JSON.parse(prevTupleRaw) as {
        billingSequence?: number;
        serverTimestamp?: number;
      };
      if (
        Number.isFinite(prev.billingSequence) &&
        nextTuple.billingSequence < Number(prev.billingSequence)
      ) {
        logWarning('billing_emit_tuple_regression_skipped', {
          callId,
          source,
          previousSequence: prev.billingSequence,
          nextSequence: nextTuple.billingSequence,
          ...meta,
        });
        recordBillingMetric('billing_emit_tuple_regression', 1, {
          callId,
          source,
          reason: 'sequence_regression',
        });
        return;
      }
      if (
        Number.isFinite(prev.serverTimestamp) &&
        nextTuple.serverTimestamp < Number(prev.serverTimestamp)
      ) {
        logWarning('billing_emit_tuple_regression_skipped', {
          callId,
          source,
          previousServerTimestamp: prev.serverTimestamp,
          nextServerTimestamp: nextTuple.serverTimestamp,
          ...meta,
        });
        recordBillingMetric('billing_emit_tuple_regression', 1, {
          callId,
          source,
          reason: 'timestamp_regression',
        });
        return;
      }
    } catch {
      // best-effort parsing; proceed when malformed
    }
  }
  if (nextTuple.billingSequence <= 0 || nextTuple.callStartTime <= 0 || nextTuple.serverTimestamp <= 0) {
    logWarning('billing_emit_tuple_invalid_skipped', {
      callId,
      source,
      ...nextTuple,
      ...meta,
    });
    recordBillingMetric('billing_emit_tuple_invalid', 1, { callId, source });
    return;
  }

  const earningsRaw = await redis.get(callCreatorEarningsKey(callId));
  const earnRaw = parseInt(String(earningsRaw ?? '0'), 10) || 0;
  let earningsMicros = earnRaw;
  if ((session.schemaVersion ?? 0) < BILLING_SESSION_SCHEMA_VERSION) {
    earningsMicros = Math.round((earnRaw * COIN_MICROS) / 10000);
  }
  const creatorEpsMicros =
    session.creatorEarningsPerSecondMicros ??
    Math.max(0, Math.round((session.creatorEarningsPerSecond ?? 0) * COIN_MICROS));
  const earningsDisplay = Math.round((earningsMicros / COIN_MICROS) * 100) / 100;

  emitBillingStartedFromSnapshot(
    io,
    userFirebaseUid,
    creatorFirebaseUid,
    userPayload,
    {
      callId,
      billingSequence: session.billingSequence ?? 0,
      lifecycleState: session.lifecycleState ?? 'INIT',
      earnings: earningsDisplay,
      pricePerSecond: creatorEpsMicros / COIN_MICROS,
      pricePerSecondMicros: creatorEpsMicros,
      creatorEarningsPerSecond: creatorEpsMicros / COIN_MICROS,
      creatorSharePercentage: session.creatorShareAtCallTime,
      elapsedSeconds: session.elapsedSeconds ?? 0,
      serverTimestamp: userPayload.serverTimestamp,
      callStartTime: session.startTime,
    }
  );
  await redis
    .setex(
      monotonicKey,
      CALL_SESSION_TTL,
      JSON.stringify({
        billingSequence: nextTuple.billingSequence,
        serverTimestamp: nextTuple.serverTimestamp,
        callStartTime: nextTuple.callStartTime,
        lifecycleState: nextTuple.lifecycleState,
        source,
      })
    )
    .catch(() => {});

  logInfo('Replayed billing:started for existing Redis session', {
    callId,
    source,
    elapsedSeconds: session.elapsedSeconds,
    remainingSeconds: userPayload.remainingSeconds,
    ...meta,
  });
  recordBillingMetric('session_start_idempotent_replay', 1, {
    callIdPrefix: callId.length > 16 ? callId.slice(0, 16) : callId,
    source,
  });
}

export async function ensureBillingStartedReplayFreshness(
  io: Server,
  callId: string,
  source: BillingSessionStartSource,
  opts?: {
    force?: boolean;
    startCorrelationId?: string;
    startIngress?: string;
    replayReason?: string;
  }
): Promise<boolean> {
  const redis = getRedis();
  const guardKey = billingStartReplayGuardKey(callId);
  if (!opts?.force) {
    const guard = await redis.set(guardKey, String(Date.now()), 'EX', BILLING_START_REPLAY_GUARD_TTL_SECONDS, 'NX');
    if (guard !== 'OK') {
      recordBillingMetric('session_start_replay_guard_suppressed', 1, { callId, source });
      return false;
    }
  } else {
    await redis.setex(guardKey, BILLING_START_REPLAY_GUARD_TTL_SECONDS, String(Date.now())).catch(() => {});
  }
  const sessionRaw = await redis.get(callSessionKey(callId));
  if (!sessionRaw) {
    return false;
  }
  const parsed = JSON.parse(sessionRaw) as CallSession;
  if (isBootstrappingSession(parsed)) {
    return false;
  }
  normalizeV4SessionFields(parsed);
  await replayBillingStartedFromRedisSession(io, redis, callId, parsed, source, opts);
  return true;
}

function migrateSession(
  raw: Record<string, unknown>,
  coinsRaw: string | null,
  earningsRaw: string | null
): { session: CallSession; earningsMicros: number } {
  const v = Number(raw.schemaVersion) || 0;
  let earningsMicros: number;

  if (v >= BILLING_SESSION_SCHEMA_VERSION) {
    earningsMicros = Math.max(0, parseInt(String(earningsRaw ?? '0'), 10) || 0);
    const session = raw as unknown as CallSession;
    normalizeV4SessionFields(session);
    return { session, earningsMicros };
  }

  if (v === 3 || v === 2) {
    earningsMicros = Math.max(0, parseInt(String(earningsRaw ?? '0'), 10) || 0);
    const session = { ...raw, schemaVersion: BILLING_SESSION_SCHEMA_VERSION } as unknown as CallSession;
    normalizeV4SessionFields(session);
    return { session, earningsMicros };
  }


  // v1 migration
  const pricePerSecond = Number(raw.pricePerSecond) || 0;
  const creatorEarningsPerSecond = Number(raw.creatorEarningsPerSecond) || 0;
  const pricePerSecondMicros = Math.max(0, Math.round(pricePerSecond * COIN_MICROS));
  const creatorEarningsPerSecondMicros = Math.max(
    0,
    Math.round(creatorEarningsPerSecond * COIN_MICROS)
  );
  const elapsedSeconds = Math.max(0, Math.floor(Number(raw.elapsedSeconds) || 0));
  const startTime = Number(raw.startTime) || Date.now();
  const lastProcessedAt = startTime + elapsedSeconds * 1000;

  const eRaw = parseInt(String(earningsRaw ?? '0'), 10) || 0;
  earningsMicros = Math.max(0, Math.round((eRaw * COIN_MICROS) / LEGACY_EARNINGS_MICRO_FACTOR));

  const totalDeductedMicros = elapsedSeconds * pricePerSecondMicros;
  const totalEarnedMicros = earningsMicros;

  const session: CallSession = {
    schemaVersion: BILLING_SESSION_SCHEMA_VERSION,
    callId: String(raw.callId),
    userFirebaseUid: String(raw.userFirebaseUid),
    creatorFirebaseUid: String(raw.creatorFirebaseUid),
    userMongoId: String(raw.userMongoId),
    creatorMongoId: String(raw.creatorMongoId),
    pricePerMinute: Number(raw.pricePerMinute) || 0,
    pricePerSecondMicros,
    creatorEarningsPerSecondMicros,
    creatorShareAtCallTime: Number(raw.creatorShareAtCallTime) || 0,
    startTime,
    lastProcessedAt,
    version: Math.max(1, Math.floor(Number(raw.version) || 1)),
    billingSequence: Math.max(0, Math.floor(Number(raw.billingSequence) || 0)),
    lifecycleState: ((raw.lifecycleState as BillingLifecycleState) || 'ACTIVE'),
    totalDeductedMicros,
    totalEarnedMicros,
    elapsedSeconds,
    effectiveDurationLimitSeconds:
      Number(raw.effectiveDurationLimitSeconds) || MAX_CALL_DURATION_SECONDS,
    lastCheckpointAtMs: Number(raw.lastCheckpointAtMs) || 0,
    lastCheckpointDeductedMicros:
      raw.lastCheckpointDeductedMicros !== undefined
        ? Number(raw.lastCheckpointDeductedMicros)
        : undefined,
    lastCheckpointEarnedMicros:
      raw.lastCheckpointEarnedMicros !== undefined
        ? Number(raw.lastCheckpointEarnedMicros)
        : undefined,
    lastHealthyTickAt: Number(raw.lastHealthyTickAt) || 0,
    lastSocketEmitAt: Number(raw.lastSocketEmitAt) || 0,
    lastSequenceAdvanceAt: Number(raw.lastSequenceAdvanceAt) || 0,
    instanceId:
      typeof raw.instanceId === 'string' && raw.instanceId.length > 0
        ? raw.instanceId
        : undefined,
    runtimeEpoch: Number(raw.runtimeEpoch) || undefined,
    leaderLock:
      typeof raw.leaderLock === 'string' && raw.leaderLock.length > 0
        ? raw.leaderLock
        : undefined,
  };

  normalizeV4SessionFields(session);
  void coinsRaw;

  return { session, earningsMicros };
}

async function buildSessionFromCheckpoint(
  checkpoint: Record<string, unknown>,
  callId: string
): Promise<{ session: CallSession; balanceMicros: number; earningsMicros: number } | null> {
  const userMongoId = String(checkpoint.userMongoId || '');
  const creatorMongoId = String(checkpoint.creatorMongoId || '');
  const userFirebaseUid = String(checkpoint.userFirebaseUid || '');
  const creatorFirebaseUid = String(checkpoint.creatorFirebaseUid || '');
  if (!userMongoId || !creatorMongoId || !userFirebaseUid || !creatorFirebaseUid) {
    return null;
  }
  const startTimeMs = Number(checkpoint.startTimeMs) || Date.now();
  const lastProcessedAtMs = Number(checkpoint.lastProcessedAtMs) || startTimeMs;
  let pricePerSecondMicros = Math.max(0, Number(checkpoint.pricePerSecondMicros) || 0);
  let creatorEarningsPerSecondMicros = Math.max(
    0,
    Number(checkpoint.creatorEarningsPerSecondMicros) || 0
  );
  if (pricePerSecondMicros <= 0 && creatorMongoId) {
    try {
      const pricing = await pricingService.snapshotForCreatorCached(creatorMongoId);
      if (pricing.pricePerSecondMicros > 0) {
        pricePerSecondMicros = pricing.pricePerSecondMicros;
        creatorEarningsPerSecondMicros = pricing.creatorEarningsPerSecondMicros;
        logDebug('billing_checkpoint_pricing_backfilled', {
          callId,
          creatorMongoId,
          pricePerSecondMicros,
        });
      }
    } catch {
      /* keep zero — repair path may fix later */
    }
  }
  const totalDeductedMicros = Math.max(0, Number(checkpoint.totalDeductedMicros) || 0);
  const totalEarnedMicros = Math.max(0, Number(checkpoint.totalEarnedMicros) || 0);
  const remainingUserBalanceMicros = Math.max(
    0,
    Number(checkpoint.remainingUserBalanceMicros) || 0
  );

  const elapsedSeconds =
    pricePerSecondMicros > 0 ? Math.floor(totalDeductedMicros / pricePerSecondMicros) : 0;
  const pricePerMinute =
    pricePerSecondMicros > 0 ? Math.round((pricePerSecondMicros * 60) / COIN_MICROS) : 0;

  const session: CallSession = {
    schemaVersion: BILLING_SESSION_SCHEMA_VERSION,
    callId,
    userFirebaseUid,
    creatorFirebaseUid,
    userMongoId,
    creatorMongoId,
    pricePerMinute,
    pricePerSecondMicros,
    creatorEarningsPerSecondMicros,
    creatorShareAtCallTime: 0,
    startTime: startTimeMs,
    lastProcessedAt: lastProcessedAtMs,
    version: Math.max(1, Number(checkpoint.version) || 1),
    billingSequence: Math.max(0, Number(checkpoint.billingSequence) || 0),
    lifecycleState: (checkpoint.lifecycleState as BillingLifecycleState) || 'RECOVERING',
    totalDeductedMicros,
    totalEarnedMicros,
    elapsedSeconds,
    effectiveDurationLimitSeconds: MAX_CALL_DURATION_SECONDS,
    lastHealthyTickAt: lastProcessedAtMs,
    lastSocketEmitAt: Number(checkpoint.lastCheckpointAtMs) || lastProcessedAtMs,
    lastSequenceAdvanceAt: lastProcessedAtMs,
    expectedNextTickAtMs: lastProcessedAtMs + BILLING_PROCESS_INTERVAL_MS,
    instanceId: getBillingInstanceId(),
    runtimeEpoch: Math.max(1, Number(checkpoint.version) || 1),
    leaderLock: `runtime:${callId}`,
  };

  normalizeV4SessionFields(session);

  return {
    session,
    balanceMicros: remainingUserBalanceMicros,
    earningsMicros: totalEarnedMicros,
  };
}

/** Who invoked `startBillingSession` (for metrics and debugging multi-writer races). */
export type BillingSessionStartSource =
  | 'client_socket'
  | 'client_http'
  | 'webhook_session_started'
  | 'webhook_replay_guard'
  | 'sync_warning_autoheal'
  | 'recovery'
  | 'unknown';

type BillingStartOpts = {
  source?: BillingSessionStartSource;
  requestReceivedAtMs?: number;
  initiatedByFirebaseUid?: string;
  initiatedByRole?: 'user' | 'creator' | 'admin';
  startCorrelationId?: string;
  startIngress?: 'socket' | 'http' | 'webhook' | 'system';
};

export class BillingService {
  async startBillingSession(
    io: Server,
    userFirebaseUid: string,
    data: {
      callId: string;
      creatorFirebaseUid: string;
      creatorMongoId: string;
    },
    opts?: BillingStartOpts
  ): Promise<void> {
    const redis = getRedis();
    const { callId, creatorFirebaseUid, creatorMongoId } = data;
    const source: BillingSessionStartSource = opts?.source ?? 'unknown';
    const initiatedByFirebaseUid = opts?.initiatedByFirebaseUid;
    const initiatedByRole = opts?.initiatedByRole;
    const startCorrelationId = opts?.startCorrelationId || randomUUID();
    const startIngress = opts?.startIngress || 'system';
    const callIdPrefix = callId.length > 16 ? callId.slice(0, 16) : callId;
    const orchestratorKey = billingStartOrchestratorKey(callId);
    const orchestratorPayload = JSON.stringify({
      source,
      startIngress,
      startCorrelationId,
      instanceId: getBillingInstanceId(),
      firstSeenAt: Date.now(),
    });
    const orchestratorClaim = await redis.set(
      orchestratorKey,
      orchestratorPayload,
      'EX',
      BILLING_START_ORCHESTRATOR_TTL_SECONDS,
      'NX'
    );
    if (orchestratorClaim !== 'OK') {
      const existingSessionOnSuppress = await redis.get(callSessionKey(callId));
      if (!existingSessionOnSuppress) {
        recordBillingMetric('billing_start_suppressed_but_no_session', 1, {
          source,
          callIdPrefix,
        });
        logWarning('billing_start_suppressed_but_no_session', {
          callId,
          source,
          startIngress,
          startCorrelationId,
        });
        await redis.del(orchestratorKey).catch(() => {});
        const retryClaim = await redis.set(
          orchestratorKey,
          orchestratorPayload,
          'EX',
          BILLING_START_ORCHESTRATOR_TTL_SECONDS,
          'NX'
        );
        if (retryClaim !== 'OK') {
          const delayedSession = await waitForSessionSnapshot(redis, callId);
          if (delayedSession && !isBootstrappingSession(delayedSession)) {
            normalizeV4SessionFields(delayedSession);
            await replayBillingStartedFromRedisSession(io, redis, callId, delayedSession, source, {
              startCorrelationId,
              startIngress,
              replayReason: 'suppressed_retry_waited_session',
            });
            recordBillingMetric('session_start_suppressed_waited_session', 1, {
              source,
              callIdPrefix,
            });
            return;
          }
          await ensureBillingStartedReplayFreshness(io, callId, source, {
            startCorrelationId,
            startIngress,
            replayReason: 'suppressed_retry_failed',
          }).catch(() => {});
          recordBillingMetric('session_start_suppressed_retry_failed', 1, {
            source,
            callIdPrefix,
          });
          return;
        }
      } else {
        recordBillingMetric('session_start_duplicate', 1, {
          source,
          callIdPrefix,
          reason: 'suppressed_non_owner',
        });
        logInfo('billing_start_orchestrator_suppressed', {
          callId,
          source,
          startIngress,
          startCorrelationId,
        });
        await ensureBillingStartedReplayFreshness(io, callId, source, {
          startCorrelationId,
          startIngress,
          replayReason: 'suppressed_non_owner',
        }).catch(() => {});
        return;
      }
    }
    const startLockToken = randomUUID();
    const startLockKey = billingSessionStartLockKey(callId);
    logInfo('billing_lifecycle_start_received', billingLifecycleLogContext({
      callId,
      source,
      payerFirebaseUid: userFirebaseUid,
      creatorFirebaseUid,
      initiatedByFirebaseUid,
      initiatedByRole,
      startCorrelationId,
      startIngress,
    }));
    const startLock = await redis.set(
      startLockKey,
      startLockToken,
      'EX',
      BILLING_SESSION_START_LOCK_TTL_SECONDS,
      'NX'
    );
    if (startLock !== 'OK') {
      logWarning('billing_start_rejected_start_lock_busy', {
        ...billingLifecycleLogContext({
          callId,
          source,
          payerFirebaseUid: userFirebaseUid,
          creatorFirebaseUid,
          initiatedByFirebaseUid,
          initiatedByRole,
        }),
        attemptedSource: source,
        startCorrelationId,
        startIngress,
      });
      logInfo('Billing session start lock busy (idempotent duplicate)', {
        ...billingLifecycleLogContext({
          callId,
          source,
          payerFirebaseUid: userFirebaseUid,
          creatorFirebaseUid,
          initiatedByFirebaseUid,
          initiatedByRole,
        }),
        attemptedSource: source,
      });
      const sessionDuringLock = await redis.get(callSessionKey(callId));
      if (sessionDuringLock) {
        try {
          const parsed = JSON.parse(sessionDuringLock) as CallSession;
          if (!isBootstrappingSession(parsed)) {
            normalizeV4SessionFields(parsed);
            await replayBillingStartedFromRedisSession(io, redis, callId, parsed, source, {
              startCorrelationId,
              startIngress,
              replayReason: 'start_lock_busy',
            });
          }
        } catch (replayErr) {
          logError(
            'Failed to replay billing:started after start lock busy',
            replayErr,
            { callId }
          );
        }
      }
      recordBillingMetric('session_start_duplicate', 1, {
        source,
        callIdPrefix,
        reason: 'start_lock_busy',
      });
      return;
    }
    try {
    if (isNewCallAdmissionBlocked()) {
      recordBillingMetric('new_call_admission_rejected', 1, { source, callIdPrefix });
      logWarning('billing_start_rejected_system_busy', {
        ...billingLifecycleLogContext({
          callId,
          source,
          payerFirebaseUid: userFirebaseUid,
          creatorFirebaseUid,
          initiatedByFirebaseUid,
          initiatedByRole,
        }),
        startCorrelationId,
        startIngress,
        backpressureStage: getBillingBackpressureStage(),
      });
      io.to(`user:${userFirebaseUid}`).emit('billing:error', {
        callId,
        error: 'SYSTEM_BUSY_TRY_AGAIN',
        message: 'System is under heavy load. Please try starting the call again shortly.',
      });
      return;
    }

    const existingSession = await redis.get(callSessionKey(callId));
    if (existingSession) {
      try {
        const parsed = JSON.parse(existingSession) as CallSession;
        const startTimeMs = Number(parsed.startTime || 0);
        const ageMs = startTimeMs > 0 ? Math.max(0, Date.now() - startTimeMs) : 0;
        if (isBootstrappingSession(parsed)) {
          if (ageMs > 60_000) {
            await clearCallSessionSeed(redis, callId);
            logWarning('Cleared stale bootstrapping billing session seed', {
              callId,
              ageMs,
              source,
            });
          } else {
            logWarning('billing_start_rejected_bootstrap_in_progress', {
              ...billingLifecycleLogContext({
                callId,
                source,
                payerFirebaseUid: userFirebaseUid,
                creatorFirebaseUid,
                initiatedByFirebaseUid,
                initiatedByRole,
              }),
              ageMs,
              attemptedSource: source,
              startCorrelationId,
              startIngress,
            });
            logInfo('Billing session bootstrap in progress (idempotent duplicate)', {
              ...billingLifecycleLogContext({
                callId,
                source,
                payerFirebaseUid: userFirebaseUid,
                creatorFirebaseUid,
                initiatedByFirebaseUid,
                initiatedByRole,
              }),
              ageMs,
              attemptedSource: source,
            });
            recordBillingMetric('session_start_duplicate', 1, {
              source,
              callIdPrefix,
              reason: 'bootstrap_in_progress',
            });
            return;
          }
        } else {
          logInfo('Billing session already exists (idempotent) — replaying billing:started', {
            ...billingLifecycleLogContext({
              callId,
              source,
              payerFirebaseUid: userFirebaseUid,
              creatorFirebaseUid,
              initiatedByFirebaseUid,
              initiatedByRole,
            }),
            attemptedSource: source,
          });
          recordBillingMetric('session_start_duplicate', 1, {
            source,
            callIdPrefix,
          });
          normalizeV4SessionFields(parsed);
          await replayBillingStartedFromRedisSession(io, redis, callId, parsed, source, {
            startCorrelationId,
            startIngress,
            replayReason: 'session_exists',
          });
          return;
        }
      } catch (replayErr) {
        logError('Failed to replay billing:started for existing session', replayErr, { callId });
        logWarning('billing_start_rejected_existing_session_parse_error', {
          callId,
          source,
          startCorrelationId,
          startIngress,
        });
        return;
      }
    }

    // Pair anti-race lock: prevents dual billing sessions for the same user↔creator pair.
    const pairKey = callpairKey(userFirebaseUid, creatorFirebaseUid);
    let pairLock = await redis.set(pairKey, callId, 'EX', CALL_SESSION_TTL, 'NX');
    if (pairLock !== 'OK') {
      const pairRecovery = await tryClearStaleCallpairLock(
        redis,
        userFirebaseUid,
        creatorFirebaseUid
      );
      if (pairRecovery.cleared) {
        logInfo('billing_start_callpair_orphan_recovered', {
          callId,
          source,
          startCorrelationId,
          staleCallId: pairRecovery.staleCallId,
          reason: pairRecovery.reason,
        });
        pairLock = await redis.set(pairKey, callId, 'EX', CALL_SESSION_TTL, 'NX');
      }
    }
    if (pairLock !== 'OK') {
      const blockingCallId = await redis.get(pairKey);
      recordBillingMetric('session_start_callpair_conflict', 1, { source, callIdPrefix });
      logWarning('billing_start_rejected_callpair_conflict', {
        ...billingLifecycleLogContext({
          callId,
          source,
          payerFirebaseUid: userFirebaseUid,
          creatorFirebaseUid,
          initiatedByFirebaseUid,
          initiatedByRole,
        }),
        blockingCallId,
        startCorrelationId,
        startIngress,
      });
      io.to(`user:${userFirebaseUid}`).emit('billing:error', {
        callId,
        error: 'CALLPAIR_CONFLICT',
        message: 'A call is already being started with this creator/user. Please try again.',
      });
      return;
    }

    const slotReserve = await tryReserveActiveCallSlotsWithOrphanRetry(
      redis,
      callId,
      userFirebaseUid,
      creatorFirebaseUid
    );
    if (slotReserve === 'conflict') {
      logWarning('billing_start_rejected_active_slot_conflict', {
        ...billingLifecycleLogContext({
          callId,
          source,
          payerFirebaseUid: userFirebaseUid,
          creatorFirebaseUid,
          initiatedByFirebaseUid,
          initiatedByRole,
        }),
        callIdPrefix,
        startCorrelationId,
        startIngress,
      });
      logWarning('Active call slot conflict — rejecting billing session start', {
        ...billingLifecycleLogContext({
          callId,
          source,
          payerFirebaseUid: userFirebaseUid,
          creatorFirebaseUid,
          initiatedByFirebaseUid,
          initiatedByRole,
        }),
        callIdPrefix,
      });
      recordBillingMetric('session_start_active_slot_conflict', 1, { source, callIdPrefix });
      io.to(`user:${userFirebaseUid}`).emit('billing:error', {
        callId,
        error: 'ACTIVE_CALL_CONFLICT',
        message: 'Another call is already active for this account.',
      });
      return;
    }

    let slotsToReleaseOnFailure = true;
    let seededEarlySession = false;
    let finalSessionPersisted = false;

    try {
      const seedStartTime = Date.now();
      const earlySession: CallSession = {
        schemaVersion: BILLING_SESSION_SCHEMA_VERSION,
        billingVersion: 1,
        initialIntroMicros: 0,
        initialWalletMicros: 0,
        billingPricePerSecondMicros: 0,
        introPromoActive: false,
        introPromoSessionId: callId,
        totalIntroDeductedMicros: 0,
        totalWalletDeductedMicros: 0,
        callId,
        userFirebaseUid,
        creatorFirebaseUid,
        userMongoId: '',
        creatorMongoId: String(creatorMongoId || ''),
        initiatedByFirebaseUid,
        initiatedByRole,
        pricePerMinute: 0,
        pricePerSecondMicros: 0,
        creatorEarningsPerSecondMicros: 0,
        creatorShareAtCallTime: 0,
        startTime: seedStartTime,
        lastProcessedAt: seedStartTime,
        version: 0,
        billingSequence: 0,
        lifecycleState: 'STARTING',
        totalDeductedMicros: 0,
        totalEarnedMicros: 0,
        elapsedSeconds: 0,
        effectiveDurationLimitSeconds: MAX_CALL_DURATION_SECONDS,
        lastCheckpointAtMs: 0,
        lastHealthyTickAt: seedStartTime,
        lastSocketEmitAt: seedStartTime,
        lastSequenceAdvanceAt: seedStartTime,
        expectedNextTickAtMs: seedStartTime + BILLING_PROCESS_INTERVAL_MS,
        instanceId: getBillingInstanceId(),
        runtimeEpoch: 1,
        leaderLock: `runtime:${callId}`,
      };
      normalizeV4SessionFields(earlySession);
      await redis
        .multi()
        .setex(callSessionKey(callId), CALL_SESSION_TTL, JSON.stringify(earlySession))
        .setex(callUserIntroMicrosKey(callId), CALL_SESSION_TTL, '0')
        .setex(callUserWalletMicrosKey(callId), CALL_SESSION_TTL, '0')
        .setex(callCreatorEarningsKey(callId), CALL_SESSION_TTL, '0')
        .exec();
      seededEarlySession = true;
      logInfo('billing_session_seeded_early', {
        ...billingLifecycleLogContext({
          callId,
          source,
          payerFirebaseUid: userFirebaseUid,
          creatorFirebaseUid,
          initiatedByFirebaseUid,
          initiatedByRole,
        }),
        seededAt: new Date(seedStartTime).toISOString(),
      });
      recordBillingMetric('session_start_seeded_early', 1, {
        source,
        callIdPrefix,
      });

      const promoteResult = await promoteBootstrappingSession(
        io,
        redis,
        callId,
        earlySession,
        source,
        {
          terminateOnFailure: true,
          preserveStartTime: false,
          initiatedByFirebaseUid,
          initiatedByRole,
          seedStartTime,
        }
      );
      if (!promoteResult.ok) {
        logWarning('billing_start_rejected_promote_failed', {
          ...billingLifecycleLogContext({
            callId,
            source,
            payerFirebaseUid: userFirebaseUid,
            creatorFirebaseUid,
            initiatedByFirebaseUid,
            initiatedByRole,
          }),
          reason: promoteResult.reason,
          startCorrelationId,
          startIngress,
          seededEarlySession,
        });
        if (
          promoteResult.reason === 'invalid_participants' ||
          promoteResult.reason === 'insufficient_coins'
        ) {
          slotsToReleaseOnFailure = false;
        }
        if (
          promoteResult.reason === 'user_not_found' ||
          promoteResult.reason === 'creator_not_found'
        ) {
          throw new Error(
            promoteResult.reason === 'user_not_found'
              ? `User not found: ${userFirebaseUid}`
              : `Creator not found: ${creatorMongoId}`
          );
        }
        return;
      }

      const {
        session,
        spendableMicros,
        initialIntroMicros,
        initialWalletMicros,
        introPromoActive,
        pricePerSecondMicros,
        creatorEarningsPerSecondMicros,
      } = promoteResult;
      const effectiveDurationLimitSeconds = session.effectiveDurationLimitSeconds;
      const pricing = {
        pricePerMinute: session.pricePerMinute,
        pricePerSecondMicros: session.pricePerSecondMicros,
        creatorEarningsPerSecondMicros: session.creatorEarningsPerSecondMicros,
        creatorShareAtCallTime: session.creatorShareAtCallTime,
        pricePerSecond: session.pricePerSecondMicros / COIN_MICROS,
      };
      finalSessionPersisted = true;

      logInfo('Billing session started - Redis keys seeded', {
        ...billingLifecycleLogContext({
          callId,
          source,
          payerFirebaseUid: userFirebaseUid,
          creatorFirebaseUid,
          initiatedByFirebaseUid,
          initiatedByRole,
        }),
        introPromoActive,
        initialIntroMicros,
        initialWalletMicros,
        billingStartSource: source,
      });
      logInfo('billing_lifecycle_seed_redis_success', billingLifecycleLogContext({
        callId,
        source,
        payerFirebaseUid: userFirebaseUid,
        creatorFirebaseUid,
        initiatedByFirebaseUid,
        initiatedByRole,
      }));

    slotsToReleaseOnFailure = false;

    const maxSeconds =
      pricePerSecondMicros > 0 ? Math.floor(spendableMicros / pricePerSecondMicros) : 0;
    const serverTimestamp = Date.now();

    const userBillingStartedPayload: BillingStartedUserPayload = {
      callId,
      billingSequence: 1,
      lifecycleState: 'ACTIVE',
      coins: microsToWholeCoinsFloor(spendableMicros),
      introCreditsRemainingApprox: introPromoActive
        ? microsToWholeCoinsFloor(initialIntroMicros)
        : 0,
      introPromoActive,
      pricePerSecond: pricing.pricePerSecondMicros / COIN_MICROS,
      pricePerSecondMicros: pricing.pricePerSecondMicros,
      maxSeconds,
      elapsedSeconds: 0,
      remainingSeconds: maxSeconds,
      serverTimestamp,
      callStartTime: session.startTime,
      durationLimit: effectiveDurationLimitSeconds,
    };

    session['lifecycleState'] = (
      await transitionBillingStateWithAudit({
      callId,
      from: session.lifecycleState,
      to: 'ACTIVE',
      source: 'billing.startBillingSession',
      reason: 'session_started_emit',
      })
    ).next;
    session.billingSequence = 1;
    session.lastHealthyTickAt = serverTimestamp;
    session.lastSequenceAdvanceAt = serverTimestamp;
    session.lastSocketEmitAt = serverTimestamp;

    if (isDurableCallSessionEnabled()) {
      const creatorUser = await User.findOne({ firebaseUid: creatorFirebaseUid })
        .select('_id')
        .lean();
      await createDurableCallSessionAtStart({
        callId,
        callerId: session.userMongoId,
        creatorId: creatorUser?._id?.toString() || session.creatorMongoId,
        callerFirebaseUid: userFirebaseUid,
        creatorFirebaseUid,
        pricePerMinute: session.pricePerMinute,
        pricePerSecondMicros: session.pricePerSecondMicros,
        creatorShareAtCallTime: session.creatorShareAtCallTime,
      });
    }

    await persistCallSession(redis, callId, session);

    if (isDurableCallSessionEnabled()) {
      await flushMirrorRedisSessionToDurable(callId, session);
    }

    const settledFromPendingEnd = await consumePendingCallEndIfAny(
      io,
      redis,
      callId,
      'billing.startBillingSession.promote_active'
    );
    if (settledFromPendingEnd) {
      await releaseActiveCallSlotsIfOurs(redis, callId, userFirebaseUid, creatorFirebaseUid);
      return;
    }

    emitBillingStartedFromSnapshot(
      io,
      userFirebaseUid,
      creatorFirebaseUid,
      userBillingStartedPayload,
      {
        callId,
        billingSequence: session.billingSequence,
        lifecycleState: session.lifecycleState,
        earnings: 0,
        pricePerSecond: creatorEarningsPerSecondMicros / COIN_MICROS,
        pricePerSecondMicros: creatorEarningsPerSecondMicros,
        creatorEarningsPerSecond: creatorEarningsPerSecondMicros / COIN_MICROS,
        creatorSharePercentage: pricing.creatorShareAtCallTime,
        elapsedSeconds: 0,
        serverTimestamp,
        callStartTime: session.startTime,
      }
    );

    recordBillingMetric('session_started', 1, {
      callId,
      pricePerSecondMicros: String(pricePerSecondMicros),
      source,
      callIdPrefix,
      startIngress,
    });
    if (opts?.requestReceivedAtMs != null) {
      recordBillingMetric('billing_start_latency_ms', Date.now() - opts.requestReceivedAtMs, {
        callId,
        callIdPrefix,
        source,
        startIngress,
      });
    }

    if (featureFlags.billingDeltaCursorV3Enabled) {
      try {
        await upsertBillingCheckpointSnapshot({
          callId,
          userMongoId: session.userMongoId,
          creatorMongoId: session.creatorMongoId,
          userFirebaseUid: session.userFirebaseUid,
          creatorFirebaseUid: session.creatorFirebaseUid,
          startTimeMs: session.startTime,
          lastProcessedAtMs: session.lastProcessedAt,
          remainingUserBalanceMicros: spendableMicros,
          pricePerSecondMicros: session.pricePerSecondMicros,
          creatorEarningsPerSecondMicros: session.creatorEarningsPerSecondMicros,
          totalDeductedMicros: session.totalDeductedMicros,
          totalEarnedMicros: session.totalEarnedMicros,
          billingSequence: session.billingSequence,
          lifecycleState: session.lifecycleState,
          status: 'active',
        });
      } catch (cpErr) {
        logError('Checkpoint snapshot after billing:started failed (non-fatal)', cpErr, {
          callId,
        });
      }
    }

    try {
      await refreshActiveCallSlotsTtl(redis, userFirebaseUid, creatorFirebaseUid);
      const { isBullmqBillingEnabled, scheduleBillingJob } = await import('./billing.queue');
      if (isBullmqBillingEnabled()) {
        await scheduleBillingJob(callId, 0);
        logInfo('Billing session scheduled (BullMQ)', billingLifecycleLogContext({
          callId,
          source,
          payerFirebaseUid: userFirebaseUid,
          creatorFirebaseUid,
          initiatedByFirebaseUid,
          initiatedByRole,
        }));
        logInfo('billing_lifecycle_scheduler_registered', {
          ...billingLifecycleLogContext({
            callId,
            source,
            payerFirebaseUid: userFirebaseUid,
            creatorFirebaseUid,
            initiatedByFirebaseUid,
            initiatedByRole,
          }),
          driver: 'bullmq',
        });
      } else {
        throw new Error('ZSET billing scheduler is disabled; BullMQ is required.');
      }
    } catch (registrationError) {
      logError('CRITICAL: Failed to register call for billing', registrationError, {
        ...billingLifecycleLogContext({
          callId,
          source,
          payerFirebaseUid: userFirebaseUid,
          creatorFirebaseUid,
          initiatedByFirebaseUid,
          initiatedByRole,
        }),
        alert: true,
      });
      logError(
        'billing_lifecycle_scheduler_registration_failed',
        registrationError,
        billingLifecycleLogContext({
          callId,
          source,
          payerFirebaseUid: userFirebaseUid,
          creatorFirebaseUid,
          initiatedByFirebaseUid,
          initiatedByRole,
        })
      );
      try {
        const { recoverBillingScheduleForCall } = await import('./billing-recovery');
        const recovered = await recoverBillingScheduleForCall(callId, 'start_registration_failed');
        logInfo('billing_lifecycle_scheduler_recovery_attempted', {
          ...billingLifecycleLogContext({
            callId,
            source,
            payerFirebaseUid: userFirebaseUid,
            creatorFirebaseUid,
            initiatedByFirebaseUid,
            initiatedByRole,
          }),
          recovered,
        });
      } catch (recoveryErr) {
        logError('billing_lifecycle_scheduler_recovery_failed', recoveryErr, {
          ...billingLifecycleLogContext({
            callId,
            source,
            payerFirebaseUid: userFirebaseUid,
            creatorFirebaseUid,
            initiatedByFirebaseUid,
            initiatedByRole,
          }),
        });
      }
    }
    } catch (err) {
      if (seededEarlySession && !finalSessionPersisted) {
        await clearCallSessionSeed(redis, callId).catch(() => {});
      }
      await redis.del(orchestratorKey).catch(() => {});
      if (slotsToReleaseOnFailure) {
        await releaseActiveCallSlotsIfOurs(redis, callId, userFirebaseUid, creatorFirebaseUid);
      }
      throw err;
    }
    } finally {
      await releaseBillingCycleLock(redis, startLockKey, startLockToken);
    }
  }

  async processBillingTick(io: Server, callId: string): Promise<BillingTickResult> {
    try {
      return await retryWithBackoff(
        async () => this._processBillingCycleInternal(io, callId),
        {
          maxRetries: 3,
          initialDelay: 1000,
          maxDelay: 10000,
          retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'],
        }
      );
    } catch (error) {
      await this._addToDLQ(callId, error);
      logError('Billing cycle failed after retries', error, { callId });
      return 'stop_needs_settlement';
    }
  }

  /**
   * Drain capped billing deltas before Mongo settlement so lastProcessedAt / totalDeductedMicros
   * match wall time (see MAX_BILLING_DELTA_MS partial-tick behavior).
   */
  async flushBillingToQuiescence(
    io: Server,
    callId: string
  ): Promise<{ iterations: number; residualLagMs: number }> {
    let iterations = 0;
    let residualLagMs = 0;

    while (iterations < MAX_SETTLEMENT_FLUSH_ITERATIONS) {
      const lagBefore = await getBillingWallLagMs(callId);
      if (lagBefore === null) {
        residualLagMs = 0;
        break;
      }
      if (lagBefore < MIN_BILLING_DELTA_MS) {
        residualLagMs = lagBefore;
        break;
      }

      const prevLag = lagBefore;
      iterations += 1;
      const result = await this.processBillingTick(io, callId);

      const lagAfter = (await getBillingWallLagMs(callId)) ?? 0;
      residualLagMs = lagAfter;

      if (result === 'stop_no_session' || result === 'stop_needs_settlement') {
        break;
      }
      if (lagAfter < MIN_BILLING_DELTA_MS) {
        break;
      }
      if (result === 'tick_ok' && lagAfter >= MIN_BILLING_DELTA_MS && Math.abs(lagAfter - prevLag) < 2) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    }

    recordBillingMetric('billing_settlement_flush_iterations', iterations, { callId });
    recordBillingMetric('billing_settlement_residual_lag_ms', residualLagMs, { callId });
    await getRedis()
      .setex(
        finalFlushMarkerKey(callId),
        FINAL_FLUSH_MARKER_TTL_SECONDS,
        JSON.stringify({
          callId,
          iterations,
          residualLagMs,
          flushedAt: Date.now(),
        })
      )
      .catch(() => {});
    recordBillingMetric('billing_settlement_final_flush_marker_written', 1, { callId });

    if (iterations >= MAX_SETTLEMENT_FLUSH_ITERATIONS) {
      logWarning('Settlement billing flush hit iteration cap', {
        callId,
        iterations,
        residualLagMs,
      });
    }

    return { iterations, residualLagMs };
  }

  private async _processBillingCycleInternal(
    io: Server,
    callId: string
  ): Promise<BillingTickResult> {
    const cycleStartedAt = Date.now();
    const redis = getRedis();
    const lockKey = billingCycleLockKey(callId);
    const lockToken = randomUUID();
    const lockOk = await redis.set(lockKey, lockToken, 'PX', BILLING_CYCLE_LOCK_TTL_MS, 'NX');
    if (lockOk !== 'OK') {
      recordBillingMetric('billing_cycle_lock_deferred', 1, { callId });
      return 'tick_deferred';
    }

    // Most ticks complete well before heartbeat interval. Start the interval lazily to avoid per-tick timer churn.
    let heartbeat: NodeJS.Timeout | null = null;
    const heartbeatStarter = setTimeout(() => {
      heartbeat = setInterval(() => {
        redis.set(lockKey, lockToken, 'PX', BILLING_CYCLE_LOCK_TTL_MS, 'XX').catch(() => {});
      }, BILLING_CYCLE_LOCK_HEARTBEAT_MS);
    }, BILLING_CYCLE_LOCK_HEARTBEAT_MS);

    try {
      let sessionRaw: string | null;
      try {
        sessionRaw = await redis.get(callSessionKey(callId));
      } catch (redisError) {
        logError('CRITICAL: Redis error reading session', redisError, { callId, alert: true });
        throw redisError;
      }

      let session: CallSession;
      let introMicros = 0;
      let walletMicros = 0;
      let earningsMicros = 0;
      let parsed: Record<string, unknown> = {};
      let earningsRaw: string | null = null;

      if (!sessionRaw) {
        if (!featureFlags.billingDeltaCursorV3Enabled) {
          logWarning('Session not found in Redis', { callId });
          return 'stop_no_session';
        }
        const checkpoint = await getBillingCheckpoint(callId);
        if (!checkpoint) {
          logWarning('Session/checkpoint not found for billing tick', { callId });
          return 'stop_no_session';
        }
        const reconstructed = await buildSessionFromCheckpoint(checkpoint as Record<string, unknown>, callId);
        if (!reconstructed) {
          logWarning('Failed to reconstruct session from checkpoint', { callId });
          return 'stop_no_session';
        }
        session = reconstructed.session;
        const rem = reconstructed.balanceMicros;
        introMicros = 0;
        walletMicros = rem;
        earningsMicros = reconstructed.earningsMicros;
        normalizeV4SessionFields(session);
      } else {
        parsed = JSON.parse(sessionRaw) as Record<string, unknown>;
        const [introRaw, walletRaw, legacyMerged, earningsR] = await Promise.all([
          redis.get(callUserIntroMicrosKey(callId)),
          redis.get(callUserWalletMicrosKey(callId)),
          redis.get(callUserCoinsKey(callId)),
          redis.get(callCreatorEarningsKey(callId)),
        ]);
        earningsRaw = earningsR;

        if (introRaw !== null || walletRaw !== null) {
          introMicros = Math.max(0, parseInt(String(introRaw ?? '0'), 10) || 0);
          walletMicros = Math.max(0, parseInt(String(walletRaw ?? '0'), 10) || 0);
        } else if (legacyMerged !== null && legacyMerged !== undefined) {
          walletMicros = Math.max(0, parseInt(String(legacyMerged), 10) || 0);
          introMicros = 0;
        }

        const migrated = migrateSession(
          parsed,
          legacyMerged ?? null,
          earningsRaw as string | null
        );
        session = migrated.session;
        earningsMicros = migrated.earningsMicros;

        if (
          featureFlags.billingDeltaCursorV3Enabled &&
          (introRaw === null || walletRaw === null || earningsRaw === null)
        ) {
          const checkpoint = await getBillingCheckpoint(callId);
          const reconstructed = checkpoint
            ? await buildSessionFromCheckpoint(checkpoint as Record<string, unknown>, callId)
            : null;
          if (reconstructed) {
            const rem = reconstructed.balanceMicros;
            introMicros = 0;
            walletMicros = rem;
            earningsMicros = reconstructed.earningsMicros;
            session.lastProcessedAt = reconstructed.session.lastProcessedAt;
            session.totalDeductedMicros = reconstructed.session.totalDeductedMicros;
            session.totalEarnedMicros = reconstructed.session.totalEarnedMicros;
            session.version = Math.max(session.version, reconstructed.session.version);
            normalizeV4SessionFields(session);
          }
        }
      }

      let balanceMicros = introMicros + walletMicros;
      normalizeV4SessionFields(session);
      const terminalShort = await shortCircuitIfTerminalBillingSession(
        redis,
        callId,
        session.lifecycleState
      );
      if (terminalShort) {
        return terminalShort;
      }
      const introPromoBilling = session.introPromoActive === true;
      const now = Date.now();
      const ownershipOk = await ensureRuntimeOwnership(redis, session, callId, now);
      if (!ownershipOk) {
        logWarning('billing_runtime_owner_rejected_tick', {
          callId,
          lifecycleState: session.lifecycleState,
          billingSequence: session.billingSequence,
          runtimeEpoch: session.runtimeEpoch,
          ownerInstanceId: session.instanceId,
          workerInstanceId: getBillingInstanceId(),
        });
        return 'tick_deferred';
      }

      if (
        sessionRaw &&
        (parsed.schemaVersion === undefined ||
          Number(parsed.schemaVersion) < BILLING_SESSION_SCHEMA_VERSION)
      ) {
        recordBillingMetric('redis_ops', 7, { callId, path: 'session_migration' });
        await redis
          .multi()
          .setex(callSessionKey(callId), CALL_SESSION_TTL, JSON.stringify(session))
          .setex(callUserIntroMicrosKey(callId), CALL_SESSION_TTL, String(introMicros))
          .setex(callUserWalletMicrosKey(callId), CALL_SESSION_TTL, String(walletMicros))
          .setex(callCreatorEarningsKey(callId), CALL_SESSION_TTL, String(earningsMicros))
          .exec();
        await redis.del(callUserCoinsKey(callId)).catch(() => {});
        await refreshActiveCallSlotsTtl(redis, session.userFirebaseUid, session.creatorFirebaseUid);
        recordBillingMetric('redis_pipeline_success', 1, { callId, path: 'session_migration' });
      }

      let pricePerSecondMicros =
        session.billingPricePerSecondMicros ?? session.pricePerSecondMicros;
      const creatorEarningsPerSecondMicros = session.creatorEarningsPerSecondMicros;
      const previousDeductedMicros = session.totalDeductedMicros;
      const previousEarnedMicros = session.totalEarnedMicros;
      const previousElapsedSeconds = session.elapsedSeconds ?? 0;

      if (Number(pricePerSecondMicros) <= 0) {
        const { repairSessionPricingIfNeeded } = await import(
          './billing-session-pricing-repair.service'
        );
        const repairResult = await repairSessionPricingIfNeeded(
          io,
          callId,
          session,
          'billing_tick'
        );
        pricePerSecondMicros =
          session.billingPricePerSecondMicros ?? session.pricePerSecondMicros;
        if (Number(pricePerSecondMicros) <= 0) {
          logBillingHealthWarn('PRICING_REPAIR_FAILED', {
            callId,
            source: 'billing_tick',
            reason: repairResult.reason,
            pricePerSecondMicros: Number(pricePerSecondMicros) || 0,
          });
          logWarning('Invalid pricePerSecondMicros', { callId, pricePerSecondMicros });
          return 'tick_deferred';
        }
      }

      if (
        session.expectedNextTickAtMs &&
        Number.isFinite(session.expectedNextTickAtMs) &&
        isLiveBillingLifecycle(session.lifecycleState)
      ) {
        const tickDriftMs = Math.max(0, now - session.expectedNextTickAtMs);
        recordBillingMetric('tick_drift_ms', tickDriftMs, { callId });
        if (runsBillingWorkers()) {
          updateBackpressureStage({ tickDriftMs });
        }
      }
      let rawWallLagMs = now - session.lastProcessedAt;
      if (rawWallLagMs < 0) rawWallLagMs = 0;
      recordBillingMetric('billing_wall_lag_ms', rawWallLagMs, { callId });
      if (rawWallLagMs > MAX_BILLING_DELTA_MS) {
        recordBillingMetric('billing_delta_capped', 1, { callId });
      }
      const deltaMs = Math.min(rawWallLagMs, MAX_BILLING_DELTA_MS);

      if (deltaMs < MIN_BILLING_DELTA_MS) {
        await maybeEmitBillingKeepaliveIfDue(
          io,
          redis,
          callId,
          session,
          balanceMicros,
          introPromoBilling,
          earningsMicros,
          'short_delta'
        );
        logBillingHealthDebug('TICK_SHORT_DELTA', {
          ...billingHealthFieldsFromSession(session),
          deltaMs,
        });
        return 'tick_ok';
      }

      const activeSpendMicros = introPromoBilling ? introMicros : walletMicros;

      const settledFromPendingEnd = await consumePendingCallEndIfAny(
        io,
        redis,
        callId,
        'billing.processTick'
      );
      if (settledFromPendingEnd) {
        return 'stop_needs_settlement';
      }

      const potentialDeduct = Math.floor((deltaMs * pricePerSecondMicros) / 1000);
      const actualDeduct = Math.min(potentialDeduct, activeSpendMicros);

      if (actualDeduct <= 0) {
        if (activeSpendMicros < pricePerSecondMicros) {
          session['lifecycleState'] = (
            await transitionBillingStateWithAudit({
            callId,
            from: session.lifecycleState,
            to: 'ENDING',
            source: 'billing.processTick',
            reason: 'insufficient_balance_pre_deduct',
            })
          ).next;
          const userReason = introPromoBilling ? 'intro_promo_exhausted' : 'insufficient_coins';
          void flushBillingPersistForCallId(callId, 'insufficient_balance', session).catch(() => {});
          emitSoon(() => {
            void forceTerminateCall(io, {
              callId,
              userFirebaseUid: session.userFirebaseUid,
              creatorFirebaseUid: session.creatorFirebaseUid,
              reason: userReason,
              creatorReason: 'user_out_of_coins',
              userPayload: {
                remainingCoins: microsToWholeCoinsFloor(introMicros + walletMicros),
              },
            }).catch((err) => {
              logError('Failed force termination for insufficient balance', err, { callId });
            });
          });
          return 'stop_needs_settlement';
        }
        await maybeEmitBillingKeepaliveIfDue(
          io,
          redis,
          callId,
          session,
          balanceMicros,
          introPromoBilling,
          earningsMicros,
          'zero_deduct'
        );
        return 'tick_ok';
      }

      const timeCoveredMs = Math.floor((actualDeduct * 1000) / pricePerSecondMicros);
      const earnMicros = Math.floor((timeCoveredMs * creatorEarningsPerSecondMicros) / 1000);

      if (introPromoBilling) {
        introMicros -= actualDeduct;
        session.totalIntroDeductedMicros = (session.totalIntroDeductedMicros ?? 0) + actualDeduct;
      } else {
        walletMicros -= actualDeduct;
        session.totalWalletDeductedMicros = (session.totalWalletDeductedMicros ?? 0) + actualDeduct;
      }
      balanceMicros = introMicros + walletMicros;
      earningsMicros += earnMicros;
      session.lastProcessedAt += timeCoveredMs;
      session.totalDeductedMicros += actualDeduct;
      session.totalEarnedMicros += earnMicros;
      if (
        session.totalDeductedMicros < previousDeductedMicros ||
        session.totalEarnedMicros < previousEarnedMicros
      ) {
        recordBillingMetric('billing_invariant_monotonicity_violation', 1, { callId });
        throw new Error('Billing totals violated monotonicity invariant');
      }
      session.version += 1;
      session.billingSequence += 1;
      session.lastHealthyTickAt = now;
      session.lastSequenceAdvanceAt = now;
      if (session.lifecycleState === 'STARTING' || session.lifecycleState === 'RECOVERING') {
        session['lifecycleState'] = (
          await transitionBillingStateWithAudit({
          callId,
          from: session.lifecycleState,
          to: 'ACTIVE',
          source: 'billing.processTick',
          reason: 'first_successful_tick',
          })
        ).next;
      }

      session.elapsedSeconds =
        pricePerSecondMicros > 0
          ? Math.floor(session.totalDeductedMicros / pricePerSecondMicros)
          : 0;
      if (previousElapsedSeconds <= 0 && session.elapsedSeconds > 0) {
        logInfo('billing_lifecycle_first_tick_success', billingLifecycleLogContext({
          callId,
          source: 'tick_processor',
          payerFirebaseUid: session.userFirebaseUid,
          creatorFirebaseUid: session.creatorFirebaseUid,
          initiatedByFirebaseUid: session.initiatedByFirebaseUid,
          initiatedByRole: session.initiatedByRole,
        }));
      }
      session.expectedNextTickAtMs = session.lastProcessedAt + BILLING_PROCESS_INTERVAL_MS;

      const effectiveLimit = session.effectiveDurationLimitSeconds;
      const secondsUntilLimit = effectiveLimit - session.elapsedSeconds;
      const remainingSeconds =
        pricePerSecondMicros > 0 ? Math.floor(balanceMicros / pricePerSecondMicros) : 0;
      const roundedEarningsDisplay =
        Math.round((earningsMicros / COIN_MICROS) * 100) / 100;
      const serverTimestamp = Date.now();
      const billingSnapshot = {
        callId,
        billingSequence: session.billingSequence,
        lifecycleState: session.lifecycleState,
        userMongoId: session.userMongoId,
        creatorMongoId: session.creatorMongoId,
        userFirebaseUid: session.userFirebaseUid,
        creatorFirebaseUid: session.creatorFirebaseUid,
        startTimeMs: session.startTime,
        lastProcessedAtMs: session.lastProcessedAt,
        remainingUserBalanceMicros: balanceMicros,
        pricePerSecondMicros: session.pricePerSecondMicros,
        creatorEarningsPerSecondMicros: session.creatorEarningsPerSecondMicros,
        totalDeductedMicros: session.totalDeductedMicros,
        totalEarnedMicros: session.totalEarnedMicros,
        elapsedSeconds: session.elapsedSeconds,
        remainingSeconds,
        durationLimit: effectiveLimit,
        serverTimestamp,
        introPromoActive: introPromoBilling,
        coins: microsToWholeCoinsFloor(balanceMicros),
        coinsExact: balanceMicros / COIN_MICROS,
        earnings: roundedEarningsDisplay,
      } as const;

      if (secondsUntilLimit <= CALL_DURATION_WARNING_SECONDS && secondsUntilLimit > 0) {
        emitSoon(() => {
          io.to(`user:${session.userFirebaseUid}`).emit('call:duration-warning', {
            callId,
            elapsedSeconds: session.elapsedSeconds,
            limitSeconds: effectiveLimit,
            secondsRemaining: secondsUntilLimit,
          });
          io.to(`user:${session.creatorFirebaseUid}`).emit('call:duration-warning', {
            callId,
            elapsedSeconds: session.elapsedSeconds,
            limitSeconds: effectiveLimit,
            secondsRemaining: secondsUntilLimit,
          });
        });
        recordBillingMetric('duration_warning', 1, { callId });
      }

      if (session.elapsedSeconds >= effectiveLimit) {
        session['lifecycleState'] = (
          await transitionBillingStateWithAudit({
          callId,
          from: session.lifecycleState,
          to: 'ENDING',
          source: 'billing.processTick',
          reason: 'duration_limit_reached',
          })
        ).next;
        recordBillingMetric('duration_limit_reached', 1, { callId });
        monitoring.recordError(
          'Call duration limit reached',
          new Error(`Call ${callId} exceeded duration limit of ${effectiveLimit}s`),
          { callId, elapsedSeconds: session.elapsedSeconds, limit: effectiveLimit },
          'warning'
        );
        emitSoon(() => {
          void forceTerminateCall(io, {
            callId,
            userFirebaseUid: session.userFirebaseUid,
            creatorFirebaseUid: session.creatorFirebaseUid,
            reason: 'duration_limit_reached',
            userPayload: {
              elapsedSeconds: session.elapsedSeconds,
              limitSeconds: effectiveLimit,
            },
            creatorPayload: {
              elapsedSeconds: session.elapsedSeconds,
              limitSeconds: effectiveLimit,
            },
          }).catch((err) => {
            logError('Failed force termination for duration limit', err, { callId });
          });
        });
        return 'stop_needs_settlement';
      }

      const cpInterval = getBillingCheckpointIntervalMs();
      const cpEverySequences = getBillingCheckpointEverySequences();
      const minDeltaMicros = getBillingCheckpointMinDeltaMicros();
      if (featureFlags.billingDeltaCursorV3Enabled) {
        await advanceBillingCheckpointCursor({
          callId,
          userMongoId: session.userMongoId,
          creatorMongoId: session.creatorMongoId,
          userFirebaseUid: session.userFirebaseUid,
          creatorFirebaseUid: session.creatorFirebaseUid,
          startTimeMs: billingSnapshot.startTimeMs,
          lastProcessedAtMs: billingSnapshot.lastProcessedAtMs,
          remainingUserBalanceMicros: billingSnapshot.remainingUserBalanceMicros,
          pricePerSecondMicros: billingSnapshot.pricePerSecondMicros,
          creatorEarningsPerSecondMicros: billingSnapshot.creatorEarningsPerSecondMicros,
          totalDeductedMicros: billingSnapshot.totalDeductedMicros,
          totalEarnedMicros: billingSnapshot.totalEarnedMicros,
          billingSequence: billingSnapshot.billingSequence,
          lifecycleState: billingSnapshot.lifecycleState,
          expectedVersion: session.version - 1,
          status: 'active',
        });
      } else {
        const checkpointDue =
          cpInterval > 0 && Date.now() - (session.lastCheckpointAtMs || 0) >= cpInterval;
        const checkpointDueBySequence =
          cpEverySequences > 0 &&
          session.billingSequence > 0 &&
          session.billingSequence % cpEverySequences === 0;
        if (checkpointDue || checkpointDueBySequence) {
          const prevDed = session.lastCheckpointDeductedMicros;
          const prevEarn = session.lastCheckpointEarnedMicros;
          const noPriorCheckpoint = prevDed === undefined && prevEarn === undefined;
          const deltaDeduct = Math.abs(session.totalDeductedMicros - (prevDed ?? 0));
          const deltaEarn = Math.abs(session.totalEarnedMicros - (prevEarn ?? 0));
          const deltaOk =
            minDeltaMicros <= 0 ||
            noPriorCheckpoint ||
            deltaDeduct >= minDeltaMicros ||
            deltaEarn >= minDeltaMicros;
          if (deltaOk) {
            session.lastCheckpointAtMs = Date.now();
            await upsertBillingCheckpoint({
              callId,
              userMongoId: session.userMongoId,
              creatorMongoId: session.creatorMongoId,
              totalDeductedMicros: session.totalDeductedMicros,
              totalEarnedMicros: session.totalEarnedMicros,
              billingSequence: session.billingSequence,
              lifecycleState: session.lifecycleState,
            });
            session.lastCheckpointDeductedMicros = session.totalDeductedMicros;
            session.lastCheckpointEarnedMicros = session.totalEarnedMicros;
          }
        }
      }

      const redisWriteStartedAt = Date.now();
      try {
        recordBillingMetric('redis_ops', 7, { callId, path: 'tick_persist' });
        await redis
          .multi()
          .setex(callUserIntroMicrosKey(callId), CALL_SESSION_TTL, String(introMicros))
          .setex(callUserWalletMicrosKey(callId), CALL_SESSION_TTL, String(walletMicros))
          .setex(callCreatorEarningsKey(callId), CALL_SESSION_TTL, String(earningsMicros))
          .setex(callSessionKey(callId), CALL_SESSION_TTL, JSON.stringify(session))
          .exec();
        await releaseActiveCallSlotsIfTerminal(redis, session);
        await refreshActiveCallSlotsTtl(redis, session.userFirebaseUid, session.creatorFirebaseUid);
        recordBillingMetric('redis_pipeline_success', 1, { callId, path: 'tick_persist' });
        void maybeMirrorRedisSessionToDurable(callId, session).catch(() => {});
        void maybePeriodicBillingPersist(callId, session).catch(() => {});
      } catch (redisError) {
        recordBillingMetric('redis_pipeline_failure', 1, { callId, path: 'tick_persist' });
        logError('CRITICAL: Redis error during billing cycle', redisError, {
          callId,
          alert: true,
          redisPath: 'tick_persist',
          redisOpCount: 4,
          redisWriteMs: Date.now() - redisWriteStartedAt,
          lifecycleState: session.lifecycleState,
          billingSequence: session.billingSequence,
          elapsedSeconds: session.elapsedSeconds,
          payerFirebaseUid: session.userFirebaseUid,
          creatorFirebaseUid: session.creatorFirebaseUid,
        });
        emitSoon(() => {
          io.to(`user:${session.userFirebaseUid}`).emit('billing:error', {
            callId,
            error: 'REDIS_ERROR',
            message: 'Billing update failed. Call will be settled when it ends.',
          });
        });
        throw redisError;
      }
      const redisWriteMs = Date.now() - redisWriteStartedAt;
      recordBillingMetric('redis_write_ms', redisWriteMs, { callId });
      const activeStage =
        isLiveBillingLifecycle(session.lifecycleState) && runsBillingWorkers()
          ? updateBackpressureStage({ redisWriteMs })
          : getBillingBackpressureStage();

      recordBillingMetric('tick_processed', 1, { callId });
      recordBillingMetric('elapsed_seconds', session.elapsedSeconds, { callId });

      const emitIntervalMs = getEmitIntervalForStage(getBillingEmitIntervalMs());
      const backpressureMs = getBillingRedisBackpressureMs();
      const nowMs = Date.now();
      const timeSinceLastEmit = nowMs - (session.lastEmitAtMs || 0);
      const isEmitDue = session.lastEmitAtMs === undefined || timeSinceLastEmit >= emitIntervalMs;
      const activeRemain = introPromoBilling ? introMicros : walletMicros;
      const isLowBalance = activeRemain < pricePerSecondMicros * 3;
      const shouldEmitUpdate =
        (isEmitDue || isLowBalance) && redisWriteMs <= backpressureMs && activeStage < 3;

      if (shouldEmitUpdate) {
        session.lastEmitAtMs = nowMs;
        session.lastSocketEmitAt = nowMs;
        recordBillingMetric('redis_ops', 1, { callId, path: 'emit_state_persist' });
        await persistCallSession(redis, callId, session);
        await refreshActiveCallSlotsTtl(redis, session.userFirebaseUid, session.creatorFirebaseUid);
        recordBillingMetric('redis_pipeline_success', 1, { callId, path: 'emit_state_persist' });
        emitSoon(() => {
          emitBillingUpdateFromSnapshot(
            io,
            session.userFirebaseUid,
            session.creatorFirebaseUid,
            {
              callId: billingSnapshot.callId,
              billingSequence: billingSnapshot.billingSequence,
              lifecycleState: billingSnapshot.lifecycleState,
              coins: billingSnapshot.coins,
              coinsExact: billingSnapshot.coinsExact,
              elapsedSeconds: billingSnapshot.elapsedSeconds,
              remainingSeconds: billingSnapshot.remainingSeconds,
              durationLimit: billingSnapshot.durationLimit,
              serverTimestamp: billingSnapshot.serverTimestamp,
              callStartTime: session.startTime,
              introPromoActive: billingSnapshot.introPromoActive,
              pricePerSecondMicros: billingSnapshot.pricePerSecondMicros,
            },
            {
              callId: billingSnapshot.callId,
              billingSequence: billingSnapshot.billingSequence,
              lifecycleState: billingSnapshot.lifecycleState,
              earnings: billingSnapshot.earnings,
              elapsedSeconds: billingSnapshot.elapsedSeconds,
              durationLimit: billingSnapshot.durationLimit,
              serverTimestamp: billingSnapshot.serverTimestamp,
              callStartTime: session.startTime,
              pricePerSecondMicros: billingSnapshot.creatorEarningsPerSecondMicros,
            }
          );
        });
        logBillingHealth('EMIT_SENT', {
          ...billingHealthFieldsFromSession(session),
          trigger: 'deduct_path',
        });
        recordBillingMetric('emit_update_sent', 1, { callId });
      } else {
        const suppressReason =
          activeStage >= 3 ? 'stage3_severe' : redisWriteMs > backpressureMs ? 'redis_backpressure' : 'throttled';
        recordBillingMetric('emit_update_suppressed', 1, {
          callId,
          reason: suppressReason,
        });
        logBillingHealthDebug('EMIT_STALLED', {
          ...billingHealthFieldsFromSession(session),
          suppressReason,
          redisWriteMs,
          activeStage,
        });
        await maybeEmitBillingKeepaliveIfDue(
          io,
          redis,
          callId,
          session,
          balanceMicros,
          introPromoBilling,
          earningsMicros,
          'recovery'
        );
      }

      if (activeRemain < pricePerSecondMicros) {
        session['lifecycleState'] = (
          await transitionBillingStateWithAudit({
          callId,
          from: session.lifecycleState,
          to: 'ENDING',
          source: 'billing.processTick',
          reason: 'insufficient_balance_post_deduct',
          })
        ).next;
        emitSoon(() => {
          void forceTerminateCall(io, {
            callId,
            userFirebaseUid: session.userFirebaseUid,
            creatorFirebaseUid: session.creatorFirebaseUid,
            reason: introPromoBilling ? 'intro_promo_exhausted' : 'insufficient_coins',
            creatorReason: 'user_out_of_coins',
            userPayload: {
              remainingCoins: microsToWholeCoinsFloor(balanceMicros),
            },
          }).catch((err) => {
            logError('Failed force termination for post-tick low balance', err, { callId });
          });
        });
        return 'stop_needs_settlement';
      }

      return 'tick_ok';
    } finally {
      clearTimeout(heartbeatStarter);
      if (heartbeat) clearInterval(heartbeat);
      recordBillingMetric('tick_duration_ms', Date.now() - cycleStartedAt, { callId });
      await releaseBillingCycleLock(redis, lockKey, lockToken);
    }
  }

  private async _addToDLQ(callId: string, error: unknown): Promise<void> {
    try {
      const redis = getRedis();
      const timestamp = Date.now();
      const dlqKey = dlqBillingKey(callId, timestamp);
      const errorDetails = {
        callId,
        timestamp,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      };
      await Promise.all([
        redis.setex(dlqKey, DLQ_BILLING_TTL, JSON.stringify(errorDetails)),
        addToDLQSet(dlqKey),
      ]);
      recordBillingMetric('dlq_added', 1, { callId });
    } catch (dlqError) {
      logError('Failed to add to DLQ', dlqError, { callId });
    }
  }

}

export const billingService = new BillingService();
