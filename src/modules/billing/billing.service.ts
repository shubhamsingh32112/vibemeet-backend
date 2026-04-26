/**
 * Billing Service — time-diff, integer micro-coins, versioned sessions.
 */

import { randomUUID } from 'crypto';
import { Server } from 'socket.io';
import {
  getRedis,
  callSessionKey,
  callUserCoinsKey,
  callCreatorEarningsKey,
  ACTIVE_BILLING_CALLS_KEY,
  activeCallByUserKey,
  ACTIVE_CALL_BY_USER_TTL,
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
import { recordBillingMetric, monitoring } from '../../utils/monitoring';
import { logWarning, logInfo, logError } from '../../utils/logger';
import { retryWithBackoff } from '../../utils/retry';
import { dlqBillingKey, DLQ_BILLING_TTL } from '../../config/redis';
import { addToDLQSet } from './billing-reconciliation';
import { pricingService } from '../video/pricing.service';
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
  getBillingCheckpointMinDeltaMicros,
  getBillingEmitIntervalMs,
  getBillingRedisBackpressureMs,
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
  isNewCallAdmissionBlocked,
  updateBackpressureStage,
} from './billing-backpressure';
import { featureFlags } from '../../config/feature-flags';

const CALL_SESSION_TTL = 7200;
const FINAL_FLUSH_MARKER_PREFIX = 'billing:final_flush:';
const FINAL_FLUSH_MARKER_TTL_SECONDS = 24 * 60 * 60;

/** Legacy creator earnings used 1e4 micro-units; convert to COIN_MICROS scale. */
const LEGACY_EARNINGS_MICRO_FACTOR = 10_000;

const BILLING_CYCLE_LOCK_PREFIX = 'billing:cycle_lock:';
function billingCycleLockKey(callId: string): string {
  return `${BILLING_CYCLE_LOCK_PREFIX}${callId}`;
}
const BILLING_SESSION_START_LOCK_PREFIX = 'billing:start_lock:';
const BILLING_SESSION_START_LOCK_TTL_SECONDS = 30;
function billingSessionStartLockKey(callId: string): string {
  return `${BILLING_SESSION_START_LOCK_PREFIX}${callId}`;
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
  for (const [roomUid, key] of [
    [userFirebaseUid, activeCallByUserKey(userFirebaseUid)],
    [creatorFirebaseUid, activeCallByUserKey(creatorFirebaseUid)],
  ] as const) {
    const v = await redis.get(key);
    if (!v) continue;
    const hasSession = await redis.get(callSessionKey(String(v)));
    if (!hasSession) {
      await redis.del(key).catch(() => {});
      recordBillingMetric('session_start_active_slot_orphan_recovered', 1, {
        staleCallId: v,
        roomUid,
      });
    }
  }
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

async function releaseActiveCallSlotsIfOurs(
  redis: ReturnType<typeof getRedis>,
  callId: string,
  userFirebaseUid: string,
  creatorFirebaseUid: string
): Promise<void> {
  const userKey = activeCallByUserKey(userFirebaseUid);
  const creatorKey = activeCallByUserKey(creatorFirebaseUid);
  const [u, c] = await Promise.all([redis.get(userKey), redis.get(creatorKey)]);
  if (u === callId) await redis.del(userKey).catch(() => {});
  if (c === callId) await redis.del(creatorKey).catch(() => {});
}

async function refreshActiveCallSlotsTtl(
  redis: ReturnType<typeof getRedis>,
  userFirebaseUid: string,
  creatorFirebaseUid: string
): Promise<void> {
  await Promise.all([
    redis.expire(activeCallByUserKey(userFirebaseUid), ACTIVE_CALL_BY_USER_TTL),
    redis.expire(activeCallByUserKey(creatorFirebaseUid), ACTIVE_CALL_BY_USER_TTL),
  ]);
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
  | 'stop_no_session'
  | 'stop_needs_settlement';

export interface CallSession {
  schemaVersion: number;
  callId: string;
  userFirebaseUid: string;
  creatorFirebaseUid: string;
  userMongoId: string;
  creatorMongoId: string;
  pricePerMinute: number;
  /** Integer micro-coins charged from user per second */
  pricePerSecondMicros: number;
  /** Integer micro-coins to creator per second */
  creatorEarningsPerSecondMicros: number;
  creatorShareAtCallTime: number;
  startTime: number;
  lastProcessedAt: number;
  version: number;
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
  /** Expected next tick time for drift telemetry. */
  expectedNextTickAtMs?: number;
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

function migrateSession(
  raw: Record<string, unknown>,
  coinsRaw: string | null,
  earningsRaw: string | null
): { session: CallSession; balanceMicros: number; earningsMicros: number } {
  const v = Number(raw.schemaVersion) || 0;
  let balanceMicros: number;
  let earningsMicros: number;

  if (v >= BILLING_SESSION_SCHEMA_VERSION) {
    balanceMicros = Math.max(0, parseInt(String(coinsRaw ?? '0'), 10) || 0);
    earningsMicros = Math.max(0, parseInt(String(earningsRaw ?? '0'), 10) || 0);
    const session = raw as unknown as CallSession;
    return { session, balanceMicros, earningsMicros };
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

  const coinsFloat = parseFloat(String(coinsRaw ?? '0')) || 0;
  balanceMicros = Math.max(0, Math.round(coinsFloat * COIN_MICROS));

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
  };

  return { session, balanceMicros, earningsMicros };
}

function buildSessionFromCheckpoint(
  checkpoint: Record<string, unknown>,
  callId: string
): { session: CallSession; balanceMicros: number; earningsMicros: number } | null {
  const userMongoId = String(checkpoint.userMongoId || '');
  const creatorMongoId = String(checkpoint.creatorMongoId || '');
  const userFirebaseUid = String(checkpoint.userFirebaseUid || '');
  const creatorFirebaseUid = String(checkpoint.creatorFirebaseUid || '');
  if (!userMongoId || !creatorMongoId || !userFirebaseUid || !creatorFirebaseUid) {
    return null;
  }
  const startTimeMs = Number(checkpoint.startTimeMs) || Date.now();
  const lastProcessedAtMs = Number(checkpoint.lastProcessedAtMs) || startTimeMs;
  const pricePerSecondMicros = Math.max(0, Number(checkpoint.pricePerSecondMicros) || 0);
  const creatorEarningsPerSecondMicros = Math.max(
    0,
    Number(checkpoint.creatorEarningsPerSecondMicros) || 0
  );
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
    totalDeductedMicros,
    totalEarnedMicros,
    elapsedSeconds,
    effectiveDurationLimitSeconds: MAX_CALL_DURATION_SECONDS,
    expectedNextTickAtMs: lastProcessedAtMs + BILLING_PROCESS_INTERVAL_MS,
  };

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
  | 'recovery'
  | 'unknown';

export class BillingService {
  async startBillingSession(
    io: Server,
    userFirebaseUid: string,
    data: {
      callId: string;
      creatorFirebaseUid: string;
      creatorMongoId: string;
    },
    opts?: { source?: BillingSessionStartSource; requestReceivedAtMs?: number }
  ): Promise<void> {
    const redis = getRedis();
    const { callId, creatorFirebaseUid, creatorMongoId } = data;
    const source: BillingSessionStartSource = opts?.source ?? 'unknown';
    const callIdPrefix = callId.length > 16 ? callId.slice(0, 16) : callId;
    const startLockToken = randomUUID();
    const startLockKey = billingSessionStartLockKey(callId);
    const startLock = await redis.set(
      startLockKey,
      startLockToken,
      'EX',
      BILLING_SESSION_START_LOCK_TTL_SECONDS,
      'NX'
    );
    if (startLock !== 'OK') {
      logInfo('Billing session start lock busy (idempotent duplicate)', {
        callId,
        attemptedSource: source,
      });
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
      io.to(`user:${userFirebaseUid}`).emit('billing:error', {
        callId,
        error: 'SYSTEM_BUSY_TRY_AGAIN',
        message: 'System is under heavy load. Please try starting the call again shortly.',
      });
      return;
    }

    const existingSession = await redis.get(callSessionKey(callId));
    if (existingSession) {
      logInfo('Billing session already exists (idempotent)', {
        callId,
        attemptedSource: source,
      });
      recordBillingMetric('session_start_duplicate', 1, {
        source,
        callIdPrefix,
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
      logWarning('Active call slot conflict — rejecting billing session start', {
        callId,
        userFirebaseUid,
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

    try {
    const user = await User.findOne({ firebaseUid: userFirebaseUid });
    if (!user) throw new Error(`User not found: ${userFirebaseUid}`);

    let creator = await Creator.findById(creatorMongoId);
    if (!creator) {
      creator = await Creator.findOne({ userId: creatorMongoId });
    }
    if (!creator) throw new Error(`Creator not found: ${creatorMongoId}`);

    const pricing = pricingService.snapshotFromLoadedCreator(creator);
    void pricingService.warmSnapshotCache(creator._id.toString(), pricing);
    const pricePerSecondMicros = pricing.pricePerSecondMicros;
    const creatorEarningsPerSecondMicros = pricing.creatorEarningsPerSecondMicros;

    const balanceMicros = coinsWholeToMicros(user.coins);
    const minEntryMicros = coinsWholeToMicros(MIN_COINS_TO_CALL);
    if (balanceMicros < Math.max(pricePerSecondMicros, minEntryMicros)) {
      await releaseActiveCallSlotsIfOurs(redis, callId, userFirebaseUid, creatorFirebaseUid);
      slotsToReleaseOnFailure = false;
      void forceTerminateCall(io, {
        callId,
        userFirebaseUid,
        creatorFirebaseUid,
        reason: balanceMicros < minEntryMicros ? 'min_coins_not_met' : 'insufficient_coins',
        creatorReason: 'user_out_of_coins',
        userPayload: {
          remainingCoins: user.coins,
          minCoinsRequired: MIN_COINS_TO_CALL,
        },
      }).catch((err) => {
        logError('Failed to trigger force termination at call start', err, {
          callId,
          userFirebaseUid,
        });
      });
      return;
    }

    const creatorLimit =
      (creator as { maxCallDurationSeconds?: number }).maxCallDurationSeconds ??
      DEFAULT_CREATOR_CALL_DURATION_SECONDS;
    const userLimit =
      (user as { maxCallDurationSeconds?: number }).maxCallDurationSeconds ??
      DEFAULT_USER_CALL_DURATION_SECONDS;
    const effectiveDurationLimitSeconds = Math.min(
      creatorLimit,
      userLimit,
      MAX_CALL_DURATION_SECONDS
    );

    const startTime = Date.now();
    const session: CallSession = {
      schemaVersion: BILLING_SESSION_SCHEMA_VERSION,
      callId,
      userFirebaseUid,
      creatorFirebaseUid,
      userMongoId: user._id.toString(),
      creatorMongoId: creator._id.toString(),
      pricePerMinute: pricing.pricePerMinute,
      pricePerSecondMicros,
      creatorEarningsPerSecondMicros,
      creatorShareAtCallTime: pricing.creatorShareAtCallTime,
      startTime,
      lastProcessedAt: startTime,
      version: 1,
      totalDeductedMicros: 0,
      totalEarnedMicros: 0,
      elapsedSeconds: 0,
      effectiveDurationLimitSeconds,
      lastCheckpointAtMs: 0,
      expectedNextTickAtMs: startTime + BILLING_PROCESS_INTERVAL_MS,
    };

    try {
      recordBillingMetric('redis_ops', 3, { callId, path: 'session_seed' });
      await redis
        .multi()
        .setex(callSessionKey(callId), CALL_SESSION_TTL, JSON.stringify(session))
        .setex(callUserCoinsKey(callId), CALL_SESSION_TTL, String(balanceMicros))
        .setex(callCreatorEarningsKey(callId), CALL_SESSION_TTL, '0')
        .exec();
      recordBillingMetric('redis_pipeline_success', 1, { callId, path: 'session_seed' });

      logInfo('Billing session started - Redis keys seeded', {
        callId,
        initialBalanceMicros: balanceMicros,
        billingStartSource: source,
      });
    } catch (redisError) {
      recordBillingMetric('redis_pipeline_failure', 1, { callId, path: 'session_seed' });
      logError('CRITICAL: Failed to start billing session in Redis', redisError, {
        callId,
        userFirebaseUid,
        alert: true,
      });
      io.to(`user:${userFirebaseUid}`).emit('billing:error', {
        callId,
        error: 'REDIS_UNAVAILABLE',
        message: 'Billing system unavailable. Please try again.',
      });
      throw redisError;
    }

    slotsToReleaseOnFailure = false;

    const maxSeconds =
      pricePerSecondMicros > 0
        ? Math.floor(balanceMicros / pricePerSecondMicros)
        : 0;
    const serverTimestamp = Date.now();

    io.to(`user:${userFirebaseUid}`).emit('billing:started', {
      callId,
      coins: user.coins,
      pricePerSecond: pricing.pricePerSecondMicros / COIN_MICROS,
      pricePerSecondMicros: pricing.pricePerSecondMicros,
      maxSeconds,
      elapsedSeconds: 0,
      remainingSeconds: maxSeconds,
      serverTimestamp,
      callStartTime: session.startTime,
      durationLimit: effectiveDurationLimitSeconds,
    });

    io.to(`user:${creatorFirebaseUid}`).emit('billing:started', {
      callId,
      earnings: 0,
      pricePerSecond: creatorEarningsPerSecondMicros / COIN_MICROS,
      pricePerSecondMicros: creatorEarningsPerSecondMicros,
      creatorEarningsPerSecond: creatorEarningsPerSecondMicros / COIN_MICROS,
      creatorSharePercentage: pricing.creatorShareAtCallTime,
      elapsedSeconds: 0,
      serverTimestamp,
      callStartTime: session.startTime,
    });

    recordBillingMetric('session_started', 1, {
      callId,
      pricePerSecondMicros: String(pricePerSecondMicros),
      source,
      callIdPrefix,
    });
    if (opts?.requestReceivedAtMs != null) {
      recordBillingMetric('billing_start_latency_ms', Date.now() - opts.requestReceivedAtMs, {
        callId,
        callIdPrefix,
        source,
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
          remainingUserBalanceMicros: balanceMicros,
          pricePerSecondMicros: session.pricePerSecondMicros,
          creatorEarningsPerSecondMicros: session.creatorEarningsPerSecondMicros,
          totalDeductedMicros: session.totalDeductedMicros,
          totalEarnedMicros: session.totalEarnedMicros,
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
        await scheduleBillingJob(callId, BILLING_PROCESS_INTERVAL_MS);
        logInfo('Billing session scheduled (BullMQ)', { callId });
      } else {
        const nextBillingTime = startTime + BILLING_PROCESS_INTERVAL_MS;
        await redis.zadd(ACTIVE_BILLING_CALLS_KEY, nextBillingTime, callId);
        logInfo('Billing session registered for processing', { callId, nextBillingTime });
      }
    } catch (registrationError) {
      logError('CRITICAL: Failed to register call for billing', registrationError, {
        callId,
        alert: true,
      });
    }
    } catch (err) {
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
      return 'tick_ok';
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
      let balanceMicros = 0;
      let earningsMicros = 0;
      let parsed: Record<string, unknown> = {};
      let coinsRaw: string | null = null;
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
        const reconstructed = buildSessionFromCheckpoint(checkpoint as Record<string, unknown>, callId);
        if (!reconstructed) {
          logWarning('Failed to reconstruct session from checkpoint', { callId });
          return 'stop_no_session';
        }
        session = reconstructed.session;
        balanceMicros = reconstructed.balanceMicros;
        earningsMicros = reconstructed.earningsMicros;
      } else {
        parsed = JSON.parse(sessionRaw) as Record<string, unknown>;
        [coinsRaw, earningsRaw] = await Promise.all([
          redis.get(callUserCoinsKey(callId)),
          redis.get(callCreatorEarningsKey(callId)),
        ]);

        const migrated = migrateSession(parsed, coinsRaw as string | null, earningsRaw as string | null);
        session = migrated.session;
        balanceMicros = migrated.balanceMicros;
        earningsMicros = migrated.earningsMicros;

        if (
          featureFlags.billingDeltaCursorV3Enabled &&
          (coinsRaw === null || earningsRaw === null)
        ) {
          const checkpoint = await getBillingCheckpoint(callId);
          const reconstructed = checkpoint
            ? buildSessionFromCheckpoint(checkpoint as Record<string, unknown>, callId)
            : null;
          if (reconstructed) {
            balanceMicros = reconstructed.balanceMicros;
            earningsMicros = reconstructed.earningsMicros;
            session.lastProcessedAt = reconstructed.session.lastProcessedAt;
            session.totalDeductedMicros = reconstructed.session.totalDeductedMicros;
            session.totalEarnedMicros = reconstructed.session.totalEarnedMicros;
            session.version = Math.max(session.version, reconstructed.session.version);
          }
        }
      }

      if (
        sessionRaw &&
        (parsed.schemaVersion === undefined ||
          Number(parsed.schemaVersion) < BILLING_SESSION_SCHEMA_VERSION)
      ) {
        recordBillingMetric('redis_ops', 5, { callId, path: 'session_migration' });
        await redis
          .multi()
          .setex(callSessionKey(callId), CALL_SESSION_TTL, JSON.stringify(session))
          .setex(callUserCoinsKey(callId), CALL_SESSION_TTL, String(balanceMicros))
          .setex(callCreatorEarningsKey(callId), CALL_SESSION_TTL, String(earningsMicros))
          .exec();
        await refreshActiveCallSlotsTtl(redis, session.userFirebaseUid, session.creatorFirebaseUid);
        recordBillingMetric('redis_pipeline_success', 1, { callId, path: 'session_migration' });
      }

      const pricePerSecondMicros = session.pricePerSecondMicros;
      const creatorEarningsPerSecondMicros = session.creatorEarningsPerSecondMicros;
      const previousDeductedMicros = session.totalDeductedMicros;
      const previousEarnedMicros = session.totalEarnedMicros;

      if (pricePerSecondMicros <= 0) {
        logWarning('Invalid pricePerSecondMicros', { callId, pricePerSecondMicros });
        return 'stop_needs_settlement';
      }

      const now = Date.now();
      if (session.expectedNextTickAtMs && Number.isFinite(session.expectedNextTickAtMs)) {
        const tickDriftMs = Math.max(0, now - session.expectedNextTickAtMs);
        recordBillingMetric('tick_drift_ms', tickDriftMs, { callId });
        updateBackpressureStage({ tickDriftMs });
      }
      let rawWallLagMs = now - session.lastProcessedAt;
      if (rawWallLagMs < 0) rawWallLagMs = 0;
      recordBillingMetric('billing_wall_lag_ms', rawWallLagMs, { callId });
      if (rawWallLagMs > MAX_BILLING_DELTA_MS) {
        recordBillingMetric('billing_delta_capped', 1, { callId });
      }
      const deltaMs = Math.min(rawWallLagMs, MAX_BILLING_DELTA_MS);

      if (deltaMs < MIN_BILLING_DELTA_MS) {
        return 'tick_ok';
      }

      const potentialDeduct = Math.floor((deltaMs * pricePerSecondMicros) / 1000);
      const actualDeduct = Math.min(potentialDeduct, balanceMicros);

      if (actualDeduct <= 0) {
        if (balanceMicros < pricePerSecondMicros) {
          emitSoon(() => {
            void forceTerminateCall(io, {
              callId,
              userFirebaseUid: session.userFirebaseUid,
              creatorFirebaseUid: session.creatorFirebaseUid,
              reason: 'insufficient_coins',
              creatorReason: 'user_out_of_coins',
              userPayload: {
                remainingCoins: microsToWholeCoinsFloor(balanceMicros),
              },
            }).catch((err) => {
              logError('Failed force termination for insufficient balance', err, { callId });
            });
          });
          return 'stop_needs_settlement';
        }
        return 'tick_ok';
      }

      const timeCoveredMs = Math.floor((actualDeduct * 1000) / pricePerSecondMicros);
      const earnMicros = Math.floor((timeCoveredMs * creatorEarningsPerSecondMicros) / 1000);

      balanceMicros -= actualDeduct;
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

      session.elapsedSeconds =
        pricePerSecondMicros > 0
          ? Math.floor(session.totalDeductedMicros / pricePerSecondMicros)
          : 0;
      session.expectedNextTickAtMs = session.lastProcessedAt + BILLING_PROCESS_INTERVAL_MS;

      const effectiveLimit = session.effectiveDurationLimitSeconds;
      const secondsUntilLimit = effectiveLimit - session.elapsedSeconds;

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
      const minDeltaMicros = getBillingCheckpointMinDeltaMicros();
      if (featureFlags.billingDeltaCursorV3Enabled) {
        await advanceBillingCheckpointCursor({
          callId,
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
          expectedVersion: session.version - 1,
          status: 'active',
        });
      } else {
        const checkpointDue =
          cpInterval > 0 && Date.now() - (session.lastCheckpointAtMs || 0) >= cpInterval;
        if (checkpointDue) {
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
            });
            session.lastCheckpointDeductedMicros = session.totalDeductedMicros;
            session.lastCheckpointEarnedMicros = session.totalEarnedMicros;
          }
        }
      }

      const redisWriteStartedAt = Date.now();
      try {
        recordBillingMetric('redis_ops', 5, { callId, path: 'tick_persist' });
        await redis
          .multi()
          .setex(callUserCoinsKey(callId), CALL_SESSION_TTL, String(balanceMicros))
          .setex(callCreatorEarningsKey(callId), CALL_SESSION_TTL, String(earningsMicros))
          .setex(callSessionKey(callId), CALL_SESSION_TTL, JSON.stringify(session))
          .exec();
        await refreshActiveCallSlotsTtl(redis, session.userFirebaseUid, session.creatorFirebaseUid);
        recordBillingMetric('redis_pipeline_success', 1, { callId, path: 'tick_persist' });
      } catch (redisError) {
        recordBillingMetric('redis_pipeline_failure', 1, { callId, path: 'tick_persist' });
        logError('CRITICAL: Redis error during billing cycle', redisError, { callId, alert: true });
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
      const activeStage = updateBackpressureStage({ redisWriteMs });

      const remainingSeconds =
        pricePerSecondMicros > 0 ? Math.floor(balanceMicros / pricePerSecondMicros) : 0;
      const roundedEarningsDisplay =
        Math.round((earningsMicros / COIN_MICROS) * 100) / 100;
      const serverTimestamp = Date.now();

      recordBillingMetric('tick_processed', 1, { callId });
      recordBillingMetric('elapsed_seconds', session.elapsedSeconds, { callId });

      const emitIntervalMs = getEmitIntervalForStage(getBillingEmitIntervalMs());
      const backpressureMs = getBillingRedisBackpressureMs();
      const nowMs = Date.now();
      const timeSinceLastEmit = nowMs - (session.lastEmitAtMs || 0);
      const isEmitDue = session.lastEmitAtMs === undefined || timeSinceLastEmit >= emitIntervalMs;
      const isLowBalance = balanceMicros < pricePerSecondMicros * 3;
      const shouldEmitUpdate =
        (isEmitDue || isLowBalance) && redisWriteMs <= backpressureMs && activeStage < 3;

      if (shouldEmitUpdate) {
        session.lastEmitAtMs = nowMs;
        recordBillingMetric('redis_ops', 1, { callId, path: 'emit_state_persist' });
        await redis.setex(callSessionKey(callId), CALL_SESSION_TTL, JSON.stringify(session));
        await refreshActiveCallSlotsTtl(redis, session.userFirebaseUid, session.creatorFirebaseUid);
        recordBillingMetric('redis_pipeline_success', 1, { callId, path: 'emit_state_persist' });
        emitSoon(() => {
          io.to(`user:${session.userFirebaseUid}`).emit('billing:update', {
            callId,
            coins: microsToWholeCoinsFloor(balanceMicros),
            coinsExact: balanceMicros / COIN_MICROS,
            elapsedSeconds: session.elapsedSeconds,
            remainingSeconds,
            durationLimit: effectiveLimit,
            serverTimestamp,
            callStartTime: session.startTime,
            pricePerSecondMicros,
          });

          io.to(`user:${session.creatorFirebaseUid}`).emit('billing:update', {
            callId,
            earnings: roundedEarningsDisplay,
            elapsedSeconds: session.elapsedSeconds,
            durationLimit: effectiveLimit,
            serverTimestamp,
            callStartTime: session.startTime,
            pricePerSecondMicros: creatorEarningsPerSecondMicros,
          });
        });
        recordBillingMetric('emit_update_sent', 1, { callId });
      } else {
        recordBillingMetric('emit_update_suppressed', 1, {
          callId,
          reason: activeStage >= 3 ? 'stage3_severe' : redisWriteMs > backpressureMs ? 'redis_backpressure' : 'throttled',
        });
      }

      if (balanceMicros < pricePerSecondMicros) {
        emitSoon(() => {
          void forceTerminateCall(io, {
            callId,
            userFirebaseUid: session.userFirebaseUid,
            creatorFirebaseUid: session.creatorFirebaseUid,
            reason: 'insufficient_coins',
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
