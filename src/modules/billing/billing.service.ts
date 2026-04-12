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
} from './billing.constants';
import { upsertBillingCheckpoint } from './billing-checkpoint.service';

const CALL_SESSION_TTL = 7200;

/** Legacy creator earnings used 1e4 micro-units; convert to COIN_MICROS scale. */
const LEGACY_EARNINGS_MICRO_FACTOR = 10_000;

const BILLING_CYCLE_LOCK_PREFIX = 'billing:cycle_lock:';
function billingCycleLockKey(callId: string): string {
  return `${BILLING_CYCLE_LOCK_PREFIX}${callId}`;
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
    opts?: { source?: BillingSessionStartSource }
  ): Promise<void> {
    const redis = getRedis();
    const { callId, creatorFirebaseUid, creatorMongoId } = data;
    const source: BillingSessionStartSource = opts?.source ?? 'unknown';
    const callIdPrefix = callId.length > 16 ? callId.slice(0, 16) : callId;

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

    const user = await User.findOne({ firebaseUid: userFirebaseUid });
    if (!user) throw new Error(`User not found: ${userFirebaseUid}`);

    let creator = await Creator.findById(creatorMongoId);
    if (!creator) {
      creator = await Creator.findOne({ userId: creatorMongoId });
    }
    if (!creator) throw new Error(`Creator not found: ${creatorMongoId}`);

    const pricing = await pricingService.snapshotForCreator(creator._id.toString());
    const pricePerSecondMicros = pricing.pricePerSecondMicros;
    const creatorEarningsPerSecondMicros = pricing.creatorEarningsPerSecondMicros;

    const balanceMicros = coinsWholeToMicros(user.coins);
    if (balanceMicros < pricePerSecondMicros) {
      io.to(`user:${userFirebaseUid}`).emit('call:force-end', {
        callId,
        reason: 'insufficient_coins',
        remainingCoins: user.coins,
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
    };

    try {
      await Promise.all([
        redis.setex(callSessionKey(callId), CALL_SESSION_TTL, JSON.stringify(session)),
        redis.setex(callUserCoinsKey(callId), CALL_SESSION_TTL, String(balanceMicros)),
        redis.setex(callCreatorEarningsKey(callId), CALL_SESSION_TTL, '0'),
      ]);

      logInfo('Billing session started - Redis keys seeded', {
        callId,
        initialBalanceMicros: balanceMicros,
        billingStartSource: source,
      });
    } catch (redisError) {
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

    try {
      await Promise.all([
        redis.setex(activeCallByUserKey(userFirebaseUid), ACTIVE_CALL_BY_USER_TTL, callId),
        redis.setex(activeCallByUserKey(creatorFirebaseUid), ACTIVE_CALL_BY_USER_TTL, callId),
      ]);
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

  private async _processBillingCycleInternal(
    io: Server,
    callId: string
  ): Promise<BillingTickResult> {
    const redis = getRedis();
    const lockKey = billingCycleLockKey(callId);
    const lockToken = randomUUID();
    const lockOk = await redis.set(lockKey, lockToken, 'PX', BILLING_CYCLE_LOCK_TTL_MS, 'NX');
    if (lockOk !== 'OK') {
      return 'tick_ok';
    }

    const heartbeat = setInterval(() => {
      redis.set(lockKey, lockToken, 'PX', BILLING_CYCLE_LOCK_TTL_MS, 'XX').catch(() => {});
    }, BILLING_CYCLE_LOCK_HEARTBEAT_MS);

    try {
      let sessionRaw: string | null;
      try {
        sessionRaw = await redis.get(callSessionKey(callId));
      } catch (redisError) {
        logError('CRITICAL: Redis error reading session', redisError, { callId, alert: true });
        throw redisError;
      }

      if (!sessionRaw) {
        logWarning('Session not found in Redis', { callId });
        return 'stop_no_session';
      }

      const parsed = JSON.parse(sessionRaw) as Record<string, unknown>;
      const [coinsRaw, earningsRaw] = await Promise.all([
        redis.get(callUserCoinsKey(callId)),
        redis.get(callCreatorEarningsKey(callId)),
      ]);

      const { session, balanceMicros: bal0, earningsMicros: earn0 } = migrateSession(
        parsed,
        coinsRaw as string | null,
        earningsRaw as string | null
      );
      let balanceMicros = bal0;
      let earningsMicros = earn0;

      if (parsed.schemaVersion === undefined || Number(parsed.schemaVersion) < BILLING_SESSION_SCHEMA_VERSION) {
        await redis.setex(callSessionKey(callId), CALL_SESSION_TTL, JSON.stringify(session));
        await redis.setex(callUserCoinsKey(callId), CALL_SESSION_TTL, String(balanceMicros));
        await redis.setex(callCreatorEarningsKey(callId), CALL_SESSION_TTL, String(earningsMicros));
      }

      const pricePerSecondMicros = session.pricePerSecondMicros;
      const creatorEarningsPerSecondMicros = session.creatorEarningsPerSecondMicros;

      if (pricePerSecondMicros <= 0) {
        logWarning('Invalid pricePerSecondMicros', { callId, pricePerSecondMicros });
        return 'stop_needs_settlement';
      }

      const now = Date.now();
      let deltaMs = now - session.lastProcessedAt;
      if (deltaMs < 0) deltaMs = 0;
      deltaMs = Math.min(deltaMs, MAX_BILLING_DELTA_MS);

      if (deltaMs < MIN_BILLING_DELTA_MS) {
        return 'tick_ok';
      }

      const potentialDeduct = Math.floor((deltaMs * pricePerSecondMicros) / 1000);
      const actualDeduct = Math.min(potentialDeduct, balanceMicros);

      if (actualDeduct <= 0) {
        if (balanceMicros < pricePerSecondMicros) {
          emitSoon(() => {
            io.to(`user:${session.userFirebaseUid}`).emit('call:force-end', {
              callId,
              reason: 'insufficient_coins',
              remainingCoins: microsToWholeCoinsFloor(balanceMicros),
            });
            io.to(`user:${session.creatorFirebaseUid}`).emit('call:force-end', {
              callId,
              reason: 'user_out_of_coins',
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
      session.version += 1;

      session.elapsedSeconds =
        pricePerSecondMicros > 0
          ? Math.floor(session.totalDeductedMicros / pricePerSecondMicros)
          : 0;

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
          io.to(`user:${session.userFirebaseUid}`).emit('call:force-end', {
            callId,
            reason: 'duration_limit_reached',
            elapsedSeconds: session.elapsedSeconds,
            limitSeconds: effectiveLimit,
          });
          io.to(`user:${session.creatorFirebaseUid}`).emit('call:force-end', {
            callId,
            reason: 'duration_limit_reached',
            elapsedSeconds: session.elapsedSeconds,
            limitSeconds: effectiveLimit,
          });
        });
        return 'stop_needs_settlement';
      }

      const cpInterval = getBillingCheckpointIntervalMs();
      const minDeltaMicros = getBillingCheckpointMinDeltaMicros();
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

      try {
        await Promise.all([
          redis.setex(callUserCoinsKey(callId), CALL_SESSION_TTL, String(balanceMicros)),
          redis.setex(callCreatorEarningsKey(callId), CALL_SESSION_TTL, String(earningsMicros)),
          redis.setex(callSessionKey(callId), CALL_SESSION_TTL, JSON.stringify(session)),
        ]);
      } catch (redisError) {
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

      const remainingSeconds =
        pricePerSecondMicros > 0 ? Math.floor(balanceMicros / pricePerSecondMicros) : 0;
      const roundedEarningsDisplay =
        Math.round((earningsMicros / COIN_MICROS) * 100) / 100;
      const serverTimestamp = Date.now();

      recordBillingMetric('tick_processed', 1, { callId });
      recordBillingMetric('elapsed_seconds', session.elapsedSeconds, { callId });

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

      if (balanceMicros < pricePerSecondMicros) {
        emitSoon(() => {
          io.to(`user:${session.userFirebaseUid}`).emit('call:force-end', {
            callId,
            reason: 'insufficient_coins',
            remainingCoins: microsToWholeCoinsFloor(balanceMicros),
          });
          io.to(`user:${session.creatorFirebaseUid}`).emit('call:force-end', {
            callId,
            reason: 'user_out_of_coins',
          });
        });
        return 'stop_needs_settlement';
      }

      return 'tick_ok';
    } finally {
      clearInterval(heartbeat);
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
