/**
 * 🔥 FIX 18: Billing Service
 * 
 * Extracted billing business logic from billing.gateway.ts
 * This service handles all billing operations:
 * - Starting billing sessions
 * - Processing billing ticks
 * - Settling calls
 * - Managing call duration limits
 */

import { Server } from 'socket.io';
import {
  getRedis,
  callSessionKey,
  callUserCoinsKey,
  callCreatorEarningsKey,
  idempotencyKey,
} from '../../config/redis';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
// CoinTransaction is used in the billing gateway during settlement,
// not in this Redis-side billing service.
// NOTE: Call history, creator data updates, balance integrity checks,
// and admin notifications are handled in the billing gateway's
// settlement flow. They intentionally remain out of this service
// to keep responsibilities focused on Redis-side billing logic.
import {
  MAX_CALL_DURATION_SECONDS,
  DEFAULT_CREATOR_CALL_DURATION_SECONDS,
  DEFAULT_USER_CALL_DURATION_SECONDS,
  CALL_DURATION_WARNING_SECONDS,
  CREATOR_EARNINGS_PER_SECOND,
} from '../../config/pricing.config';
import { recordBillingMetric, monitoring } from '../../utils/monitoring';
import { logWarning, logInfo, logError } from '../../utils/logger';
import { retryWithBackoff } from '../../utils/retry';
import {
  dlqBillingKey,
  DLQ_BILLING_TTL,
} from '../../config/redis';
import { addToDLQSet } from './billing-reconciliation';
import { pricingService } from '../video/pricing.service';

const CALL_SESSION_TTL = 7200; // 2-hour TTL safety net for Redis keys
const EARNINGS_MICRO_FACTOR = 10000; // Store creator earnings as integer micro-coins to avoid float errors

interface CallSession {
  callId: string;
  userFirebaseUid: string;
  creatorFirebaseUid: string;
  userMongoId: string;
  creatorMongoId: string;
  pricePerMinute: number;
  pricePerSecond: number;
  startTime: number;
  elapsedSeconds: number;
}

export class BillingService {
  /**
   * Start a billing session for a call
   */
  async startBillingSession(
    io: Server,
    userFirebaseUid: string,
    data: {
      callId: string;
      creatorFirebaseUid: string;
      creatorMongoId: string;
    }
  ): Promise<void> {
    const redis = getRedis();
    const { callId, creatorFirebaseUid, creatorMongoId } = data;

    // Idempotency — if session already running, skip
    const existingSession = await redis.get(callSessionKey(callId));
    if (existingSession) {
      logWarning('Session already exists for call', { callId });
      return;
    }

    // Fetch user from Mongo
    const user = await User.findOne({ firebaseUid: userFirebaseUid });
    if (!user) throw new Error(`User not found: ${userFirebaseUid}`);

    // Fetch creator pricing snapshot (centralised pricing service)
    let creator = await Creator.findById(creatorMongoId);
    if (!creator) {
      creator = await Creator.findOne({ userId: creatorMongoId });
    }
    if (!creator) throw new Error(`Creator not found: ${creatorMongoId}`);

    const pricing = await pricingService.snapshotForCreator(creator._id.toString());
    const pricePerMinute = pricing.pricePerMinute;
    const pricePerSecond = pricing.pricePerSecond;

    // Check user has enough coins for at least 1 second
    if (user.coins < pricePerSecond) {
      io.to(`user:${userFirebaseUid}`).emit('call:force-end', {
        callId,
        reason: 'insufficient_coins',
        remainingCoins: user.coins,
      });
      return;
    }

    // Build session
    const session: CallSession = {
      callId,
      userFirebaseUid,
      creatorFirebaseUid,
      userMongoId: user._id.toString(),
      creatorMongoId: creator._id.toString(),
      pricePerMinute,
      pricePerSecond,
      startTime: Date.now(),
      elapsedSeconds: 0,
    };

    // Seed Redis
    await Promise.all([
      redis.setex(callSessionKey(callId), CALL_SESSION_TTL, JSON.stringify(session)),
      redis.setex(callUserCoinsKey(callId), CALL_SESSION_TTL, user.coins.toString()),
      redis.setex(callCreatorEarningsKey(callId), CALL_SESSION_TTL, '0'),
    ]);

    const maxSeconds = Math.floor(user.coins / pricePerSecond);

    // Notify both parties that billing started
    io.to(`user:${userFirebaseUid}`).emit('billing:started', {
      callId,
      coins: user.coins,
      pricePerSecond,
      maxSeconds,
    });

    io.to(`user:${creatorFirebaseUid}`).emit('billing:started', {
      callId,
      earnings: 0,
      pricePerSecond: CREATOR_EARNINGS_PER_SECOND,
    });

    // 🔥 FIX 15: Record billing start metric
    recordBillingMetric('session_started', 1, { callId, pricePerSecond: pricePerSecond.toString() });

    logInfo('Billing session started', {
      callId,
      pricePerSecond,
      userCoins: user.coins,
      maxSeconds,
    });
  }

  /**
   * Process a billing tick (called every second)
   * 🔥 FIX 5: Wrapped with retry logic and DLQ support
   * Returns true if tick was processed successfully, false if session doesn't exist or settlement needed
   */
  async processBillingTick(io: Server, callId: string): Promise<boolean> {
    try {
      // 🔥 FIX 5: Wrap with retry logic for transient failures
      return await retryWithBackoff(
        async () => this._processBillingTickInternal(io, callId),
        {
          maxRetries: 3,
          initialDelay: 1000,
          maxDelay: 10000,
          retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'],
        }
      );
    } catch (error) {
      // 🔥 FIX 5: If all retries failed, add to dead letter queue
      await this._addToDLQ(callId, error);
      logError('Billing tick processing failed after retries', error, { callId });
      return false;
    }
  }

  /**
   * Internal billing tick processing (without retry wrapper)
   */
  private async _processBillingTickInternal(io: Server, callId: string): Promise<boolean> {
    const redis = getRedis();

    // Read session
    const sessionRaw = await redis.get(callSessionKey(callId));
    if (!sessionRaw) {
      return false; // Session doesn't exist
    }

    const session: CallSession =
      typeof sessionRaw === 'string' ? JSON.parse(sessionRaw) : (sessionRaw as any);

    // Idempotency check
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const idempotencyKeyValue = idempotencyKey(callId, currentTimestamp, session.elapsedSeconds + 1);
    
    const alreadyProcessed = await redis.get(idempotencyKeyValue);
    if (alreadyProcessed) {
      logWarning('Tick already processed (idempotent)', {
        callId,
        second: session.elapsedSeconds + 1,
      });
      return true; // Return true to indicate tick was handled (even if skipped)
    }

    // Read current coins & earnings (earnings stored as integer micro-coins)
    const [coinsRaw, earningsRaw] = await Promise.all([
      redis.get(callUserCoinsKey(callId)),
      redis.get(callCreatorEarningsKey(callId)),
    ]);

    if (coinsRaw === null) {
      return false;
    }

    let coins = parseFloat(coinsRaw as string);
    let earningsMicros = parseInt((earningsRaw as string) || '0', 10) || 0;
    const deduction = session.pricePerSecond;

    // Check affordability
    if (coins < deduction) {
      logInfo('User out of coins - force-ending call', {
        callId,
        hasCoins: coins,
        needsCoins: deduction,
      });

      io.to(`user:${session.userFirebaseUid}`).emit('call:force-end', {
        callId,
        reason: 'insufficient_coins',
        remainingCoins: Math.floor(coins),
      });
      io.to(`user:${session.creatorFirebaseUid}`).emit('call:force-end', {
        callId,
        reason: 'user_out_of_coins',
      });

      // Settlement will be handled by the caller
      return false; // Signal that settlement is needed
    }

    // Apply tick
    coins -= deduction;
    // Use integer micro-coins for creator earnings to avoid floating point drift.
    // The effective earnings-per-second comes from the PricingService.
    const pricing = await pricingService.snapshotForCreator(session.creatorMongoId);
    const earningsIncrementMicros = Math.round(
      pricing.creatorEarningsPerSecond * EARNINGS_MICRO_FACTOR
    );
    earningsMicros += earningsIncrementMicros;
    session.elapsedSeconds += 1;

    // 🔥 FIX 13: Check call duration limits with warnings
    const creator = await Creator.findById(session.creatorMongoId);
    const user = await User.findById(session.userMongoId);
    
    const creatorLimit =
      (creator as any)?.maxCallDurationSeconds || DEFAULT_CREATOR_CALL_DURATION_SECONDS;
    const userLimit =
      (user as any)?.maxCallDurationSeconds || DEFAULT_USER_CALL_DURATION_SECONDS;
    const effectiveLimit = Math.min(creatorLimit, userLimit, MAX_CALL_DURATION_SECONDS);
    
    const secondsUntilLimit = effectiveLimit - session.elapsedSeconds;
    if (secondsUntilLimit <= CALL_DURATION_WARNING_SECONDS && secondsUntilLimit > 0) {
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
      recordBillingMetric('duration_warning', 1, { callId });
    }
    
    if (session.elapsedSeconds >= effectiveLimit) {
      logInfo('Call reached duration limit - force-ending', {
        callId,
        elapsedSeconds: session.elapsedSeconds,
        limit: effectiveLimit,
      });
      
      recordBillingMetric('duration_limit_reached', 1, {
        callId,
        limit: effectiveLimit.toString(),
      });
      monitoring.recordError(
        'Call duration limit reached',
        new Error(`Call ${callId} exceeded duration limit of ${effectiveLimit}s`),
        { callId, elapsedSeconds: session.elapsedSeconds, limit: effectiveLimit },
        'warning'
      );
      
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
      
      // Settlement will be handled by the caller
      return false; // Signal that settlement is needed
    }

    // Persist to Redis
    await Promise.all([
      redis.setex(callUserCoinsKey(callId), CALL_SESSION_TTL, coins.toString()),
      redis.setex(callCreatorEarningsKey(callId), CALL_SESSION_TTL, earningsMicros.toString()),
      redis.setex(callSessionKey(callId), CALL_SESSION_TTL, JSON.stringify(session)),
      redis.setex(idempotencyKeyValue, 300, '1'),
    ]);

    const remainingSeconds = Math.floor(coins / session.pricePerSecond);

    // 🔥 FIX 15: Record billing metrics
    recordBillingMetric('tick_processed', 1, { callId });
    recordBillingMetric('elapsed_seconds', session.elapsedSeconds, { callId });

    // Emit live updates
    io.to(`user:${session.userFirebaseUid}`).emit('billing:update', {
      callId,
      coins: Math.floor(coins),
      coinsExact: parseFloat(coins.toFixed(4)),
      elapsedSeconds: session.elapsedSeconds,
      remainingSeconds,
      durationLimit: effectiveLimit,
    });

    const roundedEarningsDisplay = Math.round((earningsMicros / EARNINGS_MICRO_FACTOR) * 100) / 100;
    
    io.to(`user:${session.creatorFirebaseUid}`).emit('billing:update', {
      callId,
      earnings: roundedEarningsDisplay,
      elapsedSeconds: session.elapsedSeconds,
      durationLimit: effectiveLimit,
    });
    
    return true; // Tick processed successfully
  }

  /**
   * 🔥 FIX 5: Add failed billing tick to dead letter queue
   */
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
        addToDLQSet(dlqKey), // Add to set for efficient retrieval
      ]);
      
      logWarning('Added failed billing tick to DLQ', { callId, timestamp });
      recordBillingMetric('dlq_added', 1, { callId });
    } catch (dlqError) {
      // If DLQ write fails, log but don't throw (we're already in error handling)
      logError('Failed to add to DLQ', dlqError, { callId });
    }
  }

  /**
   * Settle a call (finalize billing)
   */
  async settleCall(_io: Server, _callId: string): Promise<void> {
    // This is a large method - keeping it in the gateway for now
    // but can be extracted later if needed
    // The service provides the core billing logic, settlement can remain in gateway
    // for now to avoid breaking changes
  }
}

// Export singleton instance
export const billingService = new BillingService();
