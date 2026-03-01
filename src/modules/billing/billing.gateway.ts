import { Server } from 'socket.io';
import mongoose from 'mongoose';
import {
  getRedis,
  callSessionKey,
  callUserCoinsKey,
  callCreatorEarningsKey,
  invalidateCreatorDashboard,
  invalidateCreatorTasks,
  invalidateAdminCaches,
  ACTIVE_BILLING_CALLS_KEY,
  // 🔥 FIX 1: Redis keys for state maps
  activeCallByUserKey,
  pendingCallEndKey,
  settledCallKey,
  ACTIVE_CALL_BY_USER_TTL,
  PENDING_CALL_END_TTL,
  SETTLED_CALL_TTL,
  // 🔥 FIX 3: Distributed lock for batch processor
  BATCH_PROCESSOR_LOCK_KEY,
  BATCH_PROCESSOR_LOCK_TTL,
} from '../../config/redis';
import { User, IUser } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { CallHistory } from './call-history.model';
import { emitCreatorDataUpdated } from '../creator/creator.controller';
import { verifyUserBalance } from '../../utils/balance-integrity';
import { emitToAdmin } from '../admin/admin.gateway';
import { getStreamClient } from '../../config/stream';
import crypto from 'crypto';
import { recordBillingMetric } from '../../utils/monitoring';
import { billingService } from './billing.service';
import { logError, logWarning, logInfo, logDebug } from '../../utils/logger';
import { checkCallRateLimit } from '../../utils/rate-limit.service';

// ── Constants ─────────────────────────────────────────────────────────────
// 🔥 FIX: Batch-based billing - no per-call intervals
// Single global processor handles all calls in batches
let globalBillingProcessor: NodeJS.Timeout | null = null;
const BILLING_BATCH_SIZE = 50; // Process up to 50 calls per tick
const BILLING_TICK_INTERVAL = 1000; // 1 second

// 🔥 FIX 1: In-memory state maps moved to Redis
// All state is now stored in Redis for persistence and distribution across servers
// - activeCallsByUser → Redis keys: active:call:user:{firebaseUid}
// - pendingCallEnds → Redis keys: pending:call:ends:{callId}
// - settledCalls → Redis keys: settled:call:{callId}

// ── Types ─────────────────────────────────────────────────────────────────
interface CallSession {
  callId: string;
  userFirebaseUid: string;
  creatorFirebaseUid: string;
  userMongoId: string;
  creatorMongoId: string;
  pricePerMinute: number;
  pricePerSecond: number;
  startTime: number; // Date.now() at call start
  elapsedSeconds: number;
}

/**
 * Generate deterministic Stream Chat channel ID for a user-creator pair.
 * Must match the chat module so call activity lands in the same chat thread.
 */
function generateUserCreatorChannelId(uid1: string, uid2: string): string {
  const [a, b] = [uid1, uid2].sort();
  // Keep same 35-char format: uc_<32-char-hash>
  const hash = crypto
    .createHash('sha256')
    .update(`${a}:${b}`)
    .digest('hex')
    .slice(0, 32);
  return `uc_${hash}`;
}

function formatDurationLabel(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  
  // Show duration in minutes format (e.g., "5 minutes", "1 minute", "30 seconds")
  if (mins <= 0) {
    return `${secs} second${secs === 1 ? '' : 's'}`;
  }
  if (secs === 0) {
    return `${mins} minute${mins === 1 ? '' : 's'}`;
  }
  // Show both minutes and seconds for calls under 1 hour
  if (mins < 60) {
    return `${mins} minute${mins === 1 ? '' : 's'} ${secs} second${secs === 1 ? '' : 's'}`;
  }
  // For calls over 1 hour, show hours and minutes
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  if (remainingMins === 0) {
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${hours} hour${hours === 1 ? '' : 's'} ${remainingMins} minute${remainingMins === 1 ? '' : 's'}`;
}

// ══════════════════════════════════════════════════════════════════════════
// GATEWAY SETUP
// ══════════════════════════════════════════════════════════════════════════

/**
 * Attach billing-related socket events.
 * Called AFTER `setupAvailabilityGateway` (which installs the auth middleware).
 *
 * Events handled:
 *   Client → Server:
 *     call:started   { callId, creatorFirebaseUid, creatorMongoId }
 *     call:ended     { callId }
 *
 *   Server → Client (to user room):
 *     billing:started  { callId, coins, pricePerSecond, maxSeconds }
 *     billing:update   { callId, coins, coinsExact, elapsedSeconds, remainingSeconds }
 *     billing:settled  { callId, finalCoins, totalDeducted, durationSeconds }
 *     call:force-end   { callId, reason, remainingCoins }
 *
 *   Server → Client (to creator room):
 *     billing:started  { callId, earnings, pricePerSecond }
 *     billing:update   { callId, earnings, elapsedSeconds }
 *     billing:settled  { callId, totalEarned, durationSeconds }
 *     call:force-end   { callId, reason }
 */
export function setupBillingGateway(io: Server): void {
  io.on('connection', (socket) => {
    const firebaseUid: string | undefined = socket.data.firebaseUid;
    if (!firebaseUid) return;

    // ── Join personal room so billing can target this user ──────────
    socket.join(`user:${firebaseUid}`);
    logDebug('User joined billing room', { firebaseUid, room: `user:${firebaseUid}` });

    // ── call:started ────────────────────────────────────────────────
    socket.on(
      'call:started',
      async (data: {
        callId: string;
        creatorFirebaseUid: string;
        creatorMongoId: string;
        userFirebaseUid?: string; // Optional: for creator-initiated calls, specifies the user who pays
      }) => {
        try {
          // For creator-initiated calls, userFirebaseUid is the target user who pays
          // For user-initiated calls, firebaseUid (socket owner) is the user who pays
          const payerFirebaseUid = data.userFirebaseUid || firebaseUid;
          
          logInfo('call:started received', { 
            callId: data.callId, 
            socketFirebaseUid: firebaseUid,
            payerFirebaseUid,
            isCreatorInitiated: !!data.userFirebaseUid,
          });
          
          // 🔥 FIX 40: Check per-user rate limit before starting billing
          // Check rate limit for the payer (user), not the socket owner
          const rateLimitCheck = await checkCallRateLimit(payerFirebaseUid);
          if (!rateLimitCheck.allowed) {
            logWarning('Call rate limit exceeded', {
              payerFirebaseUid,
              callId: data.callId,
              count: rateLimitCheck.limit - rateLimitCheck.remaining,
              limit: rateLimitCheck.limit,
              resetAt: new Date(rateLimitCheck.resetAt).toISOString(),
            });
            
            // Record rate limit metric
            recordBillingMetric('rate_limit_exceeded', 1, { firebaseUid: payerFirebaseUid, callId: data.callId });
            
            // Emit error to user
            io.to(`user:${payerFirebaseUid}`).emit('billing:error', {
              callId: data.callId,
              error: 'RATE_LIMIT_EXCEEDED',
              message: `Too many call attempts. Please wait before trying again.`,
              rateLimit: {
                limit: rateLimitCheck.limit,
                remaining: rateLimitCheck.remaining,
                resetAt: rateLimitCheck.resetAt,
                windowSeconds: rateLimitCheck.windowSeconds,
              },
            });
            return;
          }
          
          logDebug('Rate limit check passed', {
            payerFirebaseUid,
            callId: data.callId,
            remaining: rateLimitCheck.remaining,
            limit: rateLimitCheck.limit,
          });
          
          // 🔥 FIX 18: Use BillingService instead of direct function call
          // Pass payerFirebaseUid (the user who pays) instead of socket firebaseUid
          await billingService.startBillingSession(io, payerFirebaseUid, data);

          // 🔥 FIX 1: Check Redis for pending call end
          const redis = getRedis();
          const pendingEndKey = pendingCallEndKey(data.callId);
          const hasPendingEnd = await redis.get(pendingEndKey);
          if (hasPendingEnd) {
            await redis.del(pendingEndKey);
            logInfo('Deferred settlement for call', { callId: data.callId });
            await settleCall(io, data.callId);
          }
        } catch (err) {
          logError('Error in call:started', err, { callId: data.callId, firebaseUid });
          // 🔥 FIX 1: Clean up pending end from Redis if start failed
          const redis = getRedis();
          await redis.del(pendingCallEndKey(data.callId)).catch(() => {});
          socket.emit('billing:error', {
            callId: data.callId,
            message: 'Failed to start billing',
          });
        }
      }
    );

    // ── call:ended ──────────────────────────────────────────────────
    socket.on('call:ended', async (data: { callId: string }) => {
      try {
        logInfo('call:ended received', { callId: data.callId, firebaseUid });

        // Check if the session exists yet (handleCallStarted may still be running)
        const redis = getRedis();
        const sessionExists = await redis.get(callSessionKey(data.callId));

        // 🔥 FIX: Check if call is in active billing set instead of activeBillingIntervals
        const isInActiveBilling = await redis.zscore(ACTIVE_BILLING_CALLS_KEY, data.callId);
        
        if (!sessionExists && !isInActiveBilling) {
          // 🔥 FIX 1: Session not created yet — defer settlement until handleCallStarted finishes
          // Store in Redis with TTL for automatic cleanup
          await redis.set(pendingCallEndKey(data.callId), '1', {
            ex: PENDING_CALL_END_TTL,
          });
          logInfo('Deferring call:ended (session not ready)', { callId: data.callId });
          return;
        }

        await settleCall(io, data.callId);
      } catch (err) {
        logError('Error in call:ended', err, { callId: data.callId, firebaseUid });
      }
    });

    // ── billing:recover-state ───────────────────────────────────────
    // 🔥 FIX: State recovery handler for frontend to recover active calls after restart
    socket.on('billing:recover-state', async () => {
      try {
        logInfo('State recovery requested', { firebaseUid });
        const redis = getRedis();
        
        // Get active call ID for this user
        const callId = await redis.get<string>(activeCallByUserKey(firebaseUid));
        
        if (!callId) {
          // No active call for this user
          socket.emit('billing:recover-state:response', {
            success: true,
            activeCalls: [],
          });
          return;
        }
        
        // Verify call is still active in billing system
        const isInActiveBilling = await redis.zscore(ACTIVE_BILLING_CALLS_KEY, callId);
        if (!isInActiveBilling) {
          // Call is no longer active, clean up
          await redis.del(activeCallByUserKey(firebaseUid));
          socket.emit('billing:recover-state:response', {
            success: true,
            activeCalls: [],
          });
          return;
        }
        
        // Get session details
        const sessionRaw = await redis.get<string>(callSessionKey(callId));
        if (!sessionRaw) {
          // Session expired, clean up
          await redis.del(activeCallByUserKey(firebaseUid));
          socket.emit('billing:recover-state:response', {
            success: true,
            activeCalls: [],
          });
          return;
        }
        
        const session: CallSession = typeof sessionRaw === 'string' 
          ? JSON.parse(sessionRaw) 
          : (sessionRaw as any);
        
        // Get current coins and earnings
        const [coinsRaw, earningsRaw] = await Promise.all([
          redis.get<string>(callUserCoinsKey(callId)),
          redis.get<string>(callCreatorEarningsKey(callId)),
        ]);
        
        const coins = parseFloat((coinsRaw as string) || '0');
        const earnings = parseFloat((earningsRaw as string) || '0');
        const remainingSeconds = Math.floor(coins / session.pricePerSecond);
        
        // Return active call details
        socket.emit('billing:recover-state:response', {
          success: true,
          activeCalls: [{
            callId: session.callId,
            coins: Math.floor(coins),
            coinsExact: parseFloat(coins.toFixed(4)),
            pricePerSecond: session.pricePerSecond,
            elapsedSeconds: session.elapsedSeconds,
            remainingSeconds,
            earnings: Math.round(earnings * 100) / 100,
          }],
        });
        
        logInfo('State recovery completed', { 
          firebaseUid, 
          callId, 
          elapsedSeconds: session.elapsedSeconds 
        });
        
        recordBillingMetric('state_recovery', 1, { callId, firebaseUid });
      } catch (err) {
        logError('State recovery failed', err, { firebaseUid });
        socket.emit('billing:recover-state:response', {
          success: false,
          error: 'Failed to recover state',
          activeCalls: [],
        });
      }
    });

    // ── Auto-settle on disconnect ─────────────────────────────────
    // If this socket was part of an active billing session, settle
    // immediately so coins stop being deducted.  settleCall is
    // idempotent — duplicate calls are safe.
    socket.on('disconnect', async (reason) => {
      logInfo('Socket disconnected', { firebaseUid, reason });
      // 🔥 FIX 1: Get callId from Redis instead of in-memory map
      const redis = getRedis();
      const callId = await redis.get<string>(activeCallByUserKey(firebaseUid));
      if (callId) {
        logInfo('Auto-settling call due to disconnect', { callId, firebaseUid });
        try {
          await settleCall(io, callId);
        } catch (err) {
          logError('Auto-settle failed', err, { callId, firebaseUid });
        }
      }
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
// CALL LIFECYCLE
// ══════════════════════════════════════════════════════════════════════════

/**
 * 🔥 FIX: Batch-based billing - register call in Redis instead of starting per-call interval
 * Delegates to BillingService and registers call for batch processing
 */
async function handleCallStarted(
  io: Server,
  userFirebaseUid: string,
  data: {
    callId: string;
    creatorFirebaseUid: string;
    creatorMongoId: string;
  }
): Promise<void> {
  // 🔥 FIX 18: Use BillingService for business logic
  await billingService.startBillingSession(io, userFirebaseUid, data);
  
  // 🔥 FIX 1: Track both participants in Redis so we can auto-settle on socket disconnect
  const redis = getRedis();
  await Promise.all([
    redis.set(activeCallByUserKey(userFirebaseUid), data.callId, {
      ex: ACTIVE_CALL_BY_USER_TTL,
    }),
    redis.set(activeCallByUserKey(data.creatorFirebaseUid), data.callId, {
      ex: ACTIVE_CALL_BY_USER_TTL,
    }),
  ]);
  
  // 🔥 FIX: Register call in Redis sorted set for batch processing
  // Score = next billing time in milliseconds
  const nextBillingTime = Date.now() + BILLING_TICK_INTERVAL;
  await redis.zadd(ACTIVE_BILLING_CALLS_KEY, {
    score: nextBillingTime,
    member: data.callId,
  });
  
  logDebug('Registered call for batch billing', { callId: data.callId, nextBillingTime });
}

// ══════════════════════════════════════════════════════════════════════════
// BATCH-BASED BILLING PROCESSOR (NO POLLING PER CALL)
// ══════════════════════════════════════════════════════════════════════════

/**
 * 🔥 FIX: Single global billing processor that processes all active calls in batches
 * Replaces per-call setInterval polling with efficient batch processing
 * 
 * 🔥 FIX 3: Added distributed locking to prevent multiple servers from processing same calls
 * 
 * How it works:
 * 1. Try to acquire distributed lock (only one server processes at a time)
 * 2. Calls register themselves in Redis sorted set with next billing time
 * 3. Single processor runs every 1 second
 * 4. Processor reads all calls due for billing (score <= now)
 * 5. Processes calls in batches (up to BILLING_BATCH_SIZE per tick)
 * 6. Updates next billing time in sorted set after processing
 */
async function processBillingBatch(io: Server): Promise<void> {
  let redis;
  try {
    redis = getRedis();
  } catch (err) {
    // 🔥 FIX: Log error when Redis is unavailable
    logError('Failed to get Redis client for batch processor', err);
    recordBillingMetric('batch_processor_redis_error', 1, {});
    return;
  }
  
  // 🔥 FIX 3: Acquire distributed lock (only one server processes batches at a time)
  let lockAcquired = false;
  try {
    const lockResult = await redis.set(BATCH_PROCESSOR_LOCK_KEY, '1', {
      nx: true,
      ex: BATCH_PROCESSOR_LOCK_TTL,
    });
    lockAcquired = lockResult === 'OK';
  } catch (err) {
    // 🔥 FIX: Log error when lock acquisition fails (Redis outage)
    logError('Failed to acquire batch processor lock', err, {
      lockKey: BATCH_PROCESSOR_LOCK_KEY,
    });
    recordBillingMetric('batch_processor_lock_failed', 1, {});
    // Don't return - check if it's a transient error or circuit breaker issue
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ETIMEDOUT')) {
      // Redis is down - this is critical, alert
      logError('CRITICAL: Redis unavailable - billing stopped', err, {
        alert: true,
        impact: 'Billing operations stopped',
      });
      recordBillingMetric('batch_processor_redis_down', 1, {});
    }
    return;
  }
  
  if (!lockAcquired) {
    // Another server is processing batches, skip this tick
    // This is normal in multi-server deployments, only log at debug level
    logDebug('Batch processor lock not acquired, skipping tick', {});
    return;
  }
  
  const now = Date.now();
  
  try {
    // Get all calls due for billing (score <= now)
    // Limit to BILLING_BATCH_SIZE to prevent overload
    // Upstash Redis uses zrange with byScore option instead of zrangebyscore
    const callsDue = await redis.zrange(
      ACTIVE_BILLING_CALLS_KEY,
      0,
      now,
      { byScore: true, offset: 0, count: BILLING_BATCH_SIZE }
    );
    
    // Handle both string array and object array responses
    const callIds: string[] = Array.isArray(callsDue)
      ? callsDue.map((item: any) => 
          typeof item === 'string' ? item : (item?.member || item?.value || String(item))
        )
      : [];
    
    if (callIds.length === 0) {
      return; // No calls to process
    }
    
    logDebug('Processing billing batch', { count: callIds.length });
    
    // Process calls in parallel (but limit concurrency)
    const processingPromises = callIds.map(async (callId: string) => {
      try {
        // Process billing tick
        const processed = await billingService.processBillingTick(io, callId);
        
        if (processed) {
          // Update next billing time (1 second from now)
          const nextBillingTime = now + BILLING_TICK_INTERVAL;
          await redis.zadd(ACTIVE_BILLING_CALLS_KEY, {
            score: nextBillingTime,
            member: callId,
          });
        } else {
          // Session doesn't exist or settlement needed - remove from active calls
          await redis.zrem(ACTIVE_BILLING_CALLS_KEY, callId);
          logDebug('Removed call from active billing (settlement needed)', { callId });
        }
      } catch (err) {
        logError('Error processing billing tick in batch', err, { callId });
        // Don't remove from set on error - will retry next tick
        // If session expired, processBillingTick will return false next time
      }
    });
    
    await Promise.all(processingPromises);
    
    // Record batch processing metric
    recordBillingMetric('batch_processed', callIds.length, {
      batchSize: callIds.length.toString(),
    });
    
  } catch (err) {
    logError('Error in billing batch processor', err);
  } finally {
    // 🔥 FIX 3: Release lock (though TTL will handle it automatically)
    // We delete it explicitly for cleaner code, but TTL is the safety net
    await redis.del(BATCH_PROCESSOR_LOCK_KEY).catch(() => {});
  }
}

/**
 * Start the global billing processor (called once on server startup)
 */
export function startGlobalBillingProcessor(io: Server): void {
  if (globalBillingProcessor) {
    logWarning('Global billing processor already running', {});
    return;
  }
  
  logInfo('Starting global billing batch processor', {
    interval: BILLING_TICK_INTERVAL,
    batchSize: BILLING_BATCH_SIZE,
  });
  
  // Process immediately on start (for any calls already in Redis)
  processBillingBatch(io).catch((err) => {
    logError('Error in initial billing batch', err);
  });
  
  // Then process every second
  globalBillingProcessor = setInterval(() => {
    processBillingBatch(io).catch((err) => {
      logError('Error in scheduled billing batch', err);
    });
  }, BILLING_TICK_INTERVAL);
}

/**
 * Stop the global billing processor (called on server shutdown)
 */
export function stopGlobalBillingProcessor(): void {
  if (globalBillingProcessor) {
    clearInterval(globalBillingProcessor);
    globalBillingProcessor = null;
    logInfo('Stopped global billing batch processor', {});
  }
}

/**
 * Remove call from active billing (called when call ends)
 */
async function removeCallFromBilling(callId: string): Promise<void> {
  const redis = getRedis();
  await redis.zrem(ACTIVE_BILLING_CALLS_KEY, callId);
  logDebug('Removed call from active billing', { callId });
}

// ══════════════════════════════════════════════════════════════════════════
// SETTLEMENT — the ONLY place that writes to MongoDB for billing
// ══════════════════════════════════════════════════════════════════════════

// Settlement lock key — prevents duplicate concurrent settlements
const SETTLE_LOCK_PREFIX = 'settle:lock:';
const settleLockKey = (callId: string): string => `${SETTLE_LOCK_PREFIX}${callId}`;

/**
 * Settle a call — debit user, credit creator, write history.
 *
 * 🔥 FIX: Uses an atomic Redis `SET NX` lock to guarantee that only ONE
 * settlement runs per call, even when multiple triggers fire concurrently
 * (socket `call:ended`, socket `disconnect` for user, socket `disconnect`
 * for creator, REST API fallback).
 */
async function settleCall(io: Server, callId: string): Promise<void> {
  // 🔥 FIX: Remove from active billing immediately (replaces stopBillingLoop)
  await removeCallFromBilling(callId);

  const redis = getRedis();

  // 🔥 FIX 1 & 4: Check Redis for settled call (removed in-memory check)
  const settledKey = settledCallKey(callId);
  const alreadySettled = await redis.get(settledKey);
  if (alreadySettled) {
    logWarning('Call already settled (Redis) — skipping', { callId });
    return;
  }

  // ── Atomic settlement lock (NX = only if not exists) ───────────────
  // Only the FIRST caller acquires the lock; every subsequent caller
  // bails out immediately.  The lock expires after 60 s as a safety net.
  const lockAcquired = await redis.set(settleLockKey(callId), '1', {
    nx: true,
    ex: 60,
  });
  if (!lockAcquired) {
    logWarning('Settlement already in progress / completed — skipping', { callId });
    return;
  }

  // 🔥 FIX 1: Mark settled in Redis (replaces in-memory set)
  await redis.set(settledKey, '1', {
    ex: SETTLED_CALL_TTL,
  });

  // ── Read final state from Redis ────────────────────────────────────
  const sessionRaw = await redis.get<string>(callSessionKey(callId));
  if (!sessionRaw) {
    logWarning('No session to settle', { callId });
    // Clean up the lock since there's nothing to settle
    await redis.del(settleLockKey(callId));
    return;
  }

  const session: CallSession =
    typeof sessionRaw === 'string' ? JSON.parse(sessionRaw) : (sessionRaw as any);

  const [finalCoinsRaw, finalEarningsRaw] = await Promise.all([
    redis.get<string>(callUserCoinsKey(callId)),
    redis.get<string>(callCreatorEarningsKey(callId)),
  ]);

  const finalCoins = parseFloat((finalCoinsRaw as string) || '0');
  // Earnings are stored as integer micro-coins in Redis to avoid floating point drift
  const earningsMicros = parseInt((finalEarningsRaw as string) || '0', 10) || 0;
  const finalEarnings = earningsMicros / 10000;
  const totalDeducted = session.elapsedSeconds * session.pricePerSecond;

  logInfo('Settling call', {
    callId,
    elapsedSeconds: session.elapsedSeconds,
    totalDeducted: totalDeducted.toFixed(2),
    creatorEarnings: finalEarnings.toFixed(2),
  });

  // ── Clean up Redis billing keys BEFORE writing to MongoDB ──────────
  // This ensures that even if another settleCall somehow slips through,
  // it will find no session and bail out above.
  await Promise.all([
    redis.del(callSessionKey(callId)),
    redis.del(callUserCoinsKey(callId)),
    redis.del(callCreatorEarningsKey(callId)),
  ]);

  // 🔥 FIX 1: Clean up user → call tracking from Redis immediately
  await Promise.all([
    redis.del(activeCallByUserKey(session.userFirebaseUid)),
    redis.del(activeCallByUserKey(session.creatorFirebaseUid)),
  ]);

  // 🔥 CRITICAL FIX: MongoDB Transaction for Financial Operations
  // Wrap all MongoDB operations in a transaction to ensure atomicity
  // This prevents partial updates that could lead to financial inconsistencies
  const dbSession = await mongoose.startSession();
  dbSession.startTransaction();

  try {
    // ── Transactional MongoDB Operations ────────────────────────────────
    // All operations below use { session: dbSession } to ensure atomicity

    // 1️⃣  Update user coin balance in MongoDB (within transaction)
    const user = await User.findById(session.userMongoId).session(dbSession);
    if (!user) {
      throw new Error(`User not found: ${session.userMongoId}`);
    }
    user.coins = Math.max(0, Math.floor(finalCoins));
    await user.save({ session: dbSession });

    // 2️⃣  Write debit transaction — idempotent by callId (within transaction)
    //     Use findOneAndUpdate with upsert so a duplicate settlement
    //     for the same callId simply overwrites (instead of inserting).
    if (totalDeducted > 0) {
      await CoinTransaction.findOneAndUpdate(
        { callId, userId: session.userMongoId, type: 'debit' },
        {
          transactionId: `call_debit_${callId}`,
          userId: session.userMongoId,
          type: 'debit',
          coins: Math.ceil(totalDeducted),
          source: 'video_call',
          description: `Video call (${session.elapsedSeconds}s) @ ${session.pricePerMinute} coins/min`,
          callId,
          status: 'completed',
        },
        { upsert: true, new: true, session: dbSession }
      );
    }

    // 3️⃣  Credit creator's coin balance + write credit transaction (within transaction)
    let creatorUser: (mongoose.Document<unknown, {}, IUser> & IUser) | null = null;
    if (finalEarnings > 0) {
      const creator = await Creator.findById(session.creatorMongoId).session(dbSession);
      if (!creator) {
        throw new Error(`Creator not found: ${session.creatorMongoId}`);
      }
      
      creatorUser = await User.findById(creator.userId).session(dbSession);
      if (!creatorUser) {
        throw new Error(`Creator user not found: ${creator.userId}`);
      }

      // 🔥 FIX 7: Round earnings to 2 decimal places to avoid floating point errors
      const roundedEarnings = Math.round(finalEarnings * 100) / 100;
      const earningsCoins = Math.round(roundedEarnings); // Integer coins for balance
      creatorUser.coins = Math.round((creatorUser.coins || 0) + earningsCoins);
      await creatorUser.save({ session: dbSession });

      // Idempotent credit transaction by callId
      // 🔥 FIX 7: Use rounded earnings for transaction
      await CoinTransaction.findOneAndUpdate(
        { callId, userId: creator.userId, type: 'credit' },
        {
          transactionId: `call_credit_${callId}`,
          userId: creator.userId,
          type: 'credit',
          coins: earningsCoins,
          source: 'video_call',
          description: `Earned from video call (${session.elapsedSeconds}s)`,
          callId,
          status: 'completed',
        },
        { upsert: true, new: true, session: dbSession }
      );
    }

    // 4️⃣  Save call history records (one per party) within transaction
    //     This ensures call history is consistent with financial transactions
    const creatorDoc = await Creator.findById(session.creatorMongoId).session(dbSession);
    const userDoc = await User.findById(session.userMongoId).session(dbSession);
    const creatorUserDoc = creatorDoc
      ? await User.findById(creatorDoc.userId).session(dbSession)
      : null;

    // Resolve display names
    const userName =
      userDoc?.username || userDoc?.phone || userDoc?.email || 'User';
    const creatorName = creatorDoc?.name || 'Creator';
    const userAvatar = userDoc?.avatar;
    const creatorAvatar = creatorDoc?.photo;
    const creatorOwnerUserId = creatorDoc?.userId; // Mongo _id of the creator's User doc
    const creatorFirebaseUid =
      creatorUserDoc?.firebaseUid || session.creatorFirebaseUid;

    // Record for the USER: "I called <creator>"
    await CallHistory.findOneAndUpdate(
      { callId, ownerUserId: session.userMongoId },
      {
        callId,
        ownerUserId: session.userMongoId,
        otherUserId: creatorOwnerUserId || session.creatorMongoId,
        otherCreatorId: creatorDoc?._id, // Creator._id for call initiation from Recents
        otherName: creatorName,
        otherAvatar: creatorAvatar,
        otherFirebaseUid: creatorFirebaseUid,
        ownerRole: 'user',
        durationSeconds: session.elapsedSeconds,
        coinsDeducted: Math.ceil(totalDeducted),
        coinsEarned: 0,
      },
      { upsert: true, new: true, session: dbSession }
    );

    // Record for the CREATOR: "I was called by <user>"
    if (creatorOwnerUserId) {
      await CallHistory.findOneAndUpdate(
        { callId, ownerUserId: creatorOwnerUserId },
        {
          callId,
          ownerUserId: creatorOwnerUserId,
          otherUserId: session.userMongoId,
          otherName: userName,
          otherAvatar: userAvatar,
          otherFirebaseUid: session.userFirebaseUid,
          ownerRole: 'creator',
          durationSeconds: session.elapsedSeconds,
          coinsDeducted: 0,
          coinsEarned: Math.floor(finalEarnings),
        },
        { upsert: true, new: true, session: dbSession }
      );
    }


    // ── Commit Transaction ──────────────────────────────────────────────
    // All MongoDB operations succeeded, commit the transaction
    await dbSession.commitTransaction();
    logInfo('Settlement transaction committed', { callId });

    // ── Non-Transactional Operations (after successful transaction) ─────
    // These operations are not critical for financial consistency and can fail
    // without affecting the settlement integrity

    // Emit coins_updated so the user's UI updates the coin balance
    io.to(`user:${session.userFirebaseUid}`).emit('coins_updated', {
      userId: user._id.toString(),
      coins: user.coins,
    });

    // Emit coins_updated so the creator's UI updates the coin balance
    if (creatorUser) {
      io.to(`user:${session.creatorFirebaseUid}`).emit('coins_updated', {
        userId: creatorUser._id.toString(),
        coins: creatorUser.coins,
      });
    }

    // 4.5️⃣ Add call activity message to user↔creator chat
    // This makes completed calls visible in the chat timeline.
    try {
      const streamClient = getStreamClient();
      const channelId = generateUserCreatorChannelId(
        session.userFirebaseUid,
        session.creatorFirebaseUid,
      );
      const channelName = creatorName;

      const channel = streamClient.channel('messaging', channelId, {
        members: [session.userFirebaseUid, session.creatorFirebaseUid],
        created_by_id: session.userFirebaseUid,
        name: channelName,
      });

      // Channel may already exist; create ensures first-time call users still get a chat thread.
      try {
        await channel.create();
      } catch (_) {
        // Ignore "already exists" and other non-fatal create errors; sendMessage may still work.
      }

      const durationLabel = formatDurationLabel(session.elapsedSeconds);
      const coinsSpent = Math.ceil(totalDeducted);
      await channel.sendMessage({
        id: `call_activity_${callId}`,
        type: 'system',
        text: `Video call completed (${durationLabel}) • ${coinsSpent} coin${coinsSpent === 1 ? '' : 's'} spent`,
      });

      logInfo('Chat call activity message posted', { callId });
    } catch (chatErr) {
      // Non-fatal — settlement remains successful.
      logError('Failed to post call activity in chat', chatErr, { callId });
    }

    // 5️⃣  Invalidate caches BEFORE emitting events to clients.
    //     This prevents a race where the frontend receives billing:settled,
    //     immediately re-fetches the dashboard, and gets stale cached data
    //     because the cache hasn't been invalidated yet.
    try {
      const creatorDoc2 = await Creator.findById(session.creatorMongoId);
      if (creatorDoc2) {
        // 🔥 SCALABILITY FIX: Invalidate both tasks and dashboard cache
        // Tasks cache needs invalidation because CallHistory is created, affecting task progress
        await invalidateCreatorTasks(creatorDoc2.userId.toString());
        await invalidateCreatorDashboard(creatorDoc2.userId.toString());
      }
      await invalidateAdminCaches('overview', 'coins', 'creators_performance');
    } catch (cacheErr) {
      logError('Failed to invalidate caches', cacheErr, { callId });
    }

    // 6️⃣  Notify both parties of final settlement
    io.to(`user:${session.userFirebaseUid}`).emit('billing:settled', {
      callId,
      finalCoins: Math.floor(finalCoins),
      totalDeducted: Math.ceil(totalDeducted),
      durationSeconds: session.elapsedSeconds,
    });

    // 🔥 FIX 7: Round final earnings to integer for settlement
    const finalEarningsRounded = Math.round(finalEarnings);
    
    io.to(`user:${session.creatorFirebaseUid}`).emit('billing:settled', {
      callId,
      totalEarned: finalEarningsRounded,
      durationSeconds: session.elapsedSeconds,
    });

    // 7️⃣  Emit real-time creator data update (triggers dashboard re-fetch)
    try {
      const creatorDoc3 = await Creator.findById(session.creatorMongoId);
      if (creatorDoc3) {
        emitCreatorDataUpdated(session.creatorFirebaseUid, {
          reason: 'call_settled',
          callId,
          totalEarned: finalEarningsRounded,
          durationSeconds: session.elapsedSeconds,
        });
      }
    } catch (emitErr) {
      logError('Failed to emit creator data update', emitErr, { callId });
    }

    // Balance integrity checks (fire-and-forget)
    verifyUserBalance(session.userMongoId).catch(() => {});
    const creatorDoc4 = await Creator.findById(session.creatorMongoId);
    if (creatorDoc4) verifyUserBalance(creatorDoc4.userId).catch(() => {});

    // Emit to admin dashboard
    emitToAdmin('billing:settled', {
      callId,
      userFirebaseUid: session.userFirebaseUid,
      creatorFirebaseUid: session.creatorFirebaseUid,
      durationSeconds: session.elapsedSeconds,
      coinsDeducted: Math.floor(totalDeducted),
      creatorEarned: finalEarningsRounded,
    });

    logInfo('Settlement complete', { callId });
  } catch (err) {
    // ── Transaction Rollback on Error ───────────────────────────────────
    // If any MongoDB operation fails, rollback the entire transaction
    // This ensures no partial updates occur
    try {
      await dbSession.abortTransaction();
      logError('Settlement transaction aborted', err, { callId });
      recordBillingMetric('settlement_transaction_failed', 1, { callId });
    } catch (abortErr) {
      logError('Failed to abort transaction', abortErr, { callId });
    }
    
    // Re-throw error so it's logged by outer catch block
    throw err;
  } finally {
    // Always end the database session
    await dbSession.endSession();
    
    // 8️⃣  Clean up lock key (allow re-settlement if the process crashed
    //     before this point — the 60 s TTL handles that case too).
    await redis.del(settleLockKey(callId)).catch(() => {});
  }
}

// ══════════════════════════════════════════════════════════════════════════
// HTTP FALLBACK HANDLERS (called from billing.routes.ts)
// ══════════════════════════════════════════════════════════════════════════

/**
 * HTTP-invocable version of handleCallStarted.
 * Used by the REST API fallback when the client's Socket.IO is not connected.
 */
export async function handleCallStartedHttp(
  io: Server,
  userFirebaseUid: string,
  data: { callId: string; creatorFirebaseUid: string; creatorMongoId: string }
): Promise<void> {
  logInfo('handleCallStartedHttp', { callId: data.callId, userFirebaseUid });
  await handleCallStarted(io, userFirebaseUid, data);

  // 🔥 FIX 1: Check Redis for pending call end
  const redis = getRedis();
  const pendingEndKey = pendingCallEndKey(data.callId);
  const hasPendingEnd = await redis.get<string>(pendingEndKey);
  if (hasPendingEnd) {
    await redis.del(pendingEndKey);
    logInfo('Deferred settlement (HTTP)', { callId: data.callId });
    await settleCall(io, data.callId);
  }
}

/**
 * HTTP-invocable version of settleCall.
 * Used by the REST API fallback when the client's Socket.IO is not connected.
 */
export async function settleCallHttp(
  io: Server,
  callId: string
): Promise<void> {
  logInfo('settleCallHttp', { callId });

  const redis = getRedis();
  const sessionExists = await redis.get(callSessionKey(callId));

  // 🔥 FIX: Check if call is in active billing set instead of activeBillingIntervals
  const isInActiveBilling = await redis.zscore(ACTIVE_BILLING_CALLS_KEY, callId);
  
  if (!sessionExists && !isInActiveBilling) {
    // 🔥 FIX 1: Store in Redis with TTL for automatic cleanup
    await redis.set(pendingCallEndKey(callId), '1', {
      ex: PENDING_CALL_END_TTL,
    });
    logInfo('Deferring call:ended (HTTP, session not ready)', { callId });
    return;
  }

  await settleCall(io, callId);
}

// ══════════════════════════════════════════════════════════════════════════
// CLEANUP (called on server shutdown)
// ══════════════════════════════════════════════════════════════════════════
export function cleanupBillingIntervals(): void {
  // 🔥 FIX: Stop global billing processor instead of per-call intervals
  stopGlobalBillingProcessor();
  
  // 🔥 FIX 1: No need to clear in-memory state (moved to Redis)
  // Redis keys have TTLs and will expire automatically
  // Active calls will be cleaned up when they settle or expire
  
  logInfo('Cleaned up billing system', {});
}
