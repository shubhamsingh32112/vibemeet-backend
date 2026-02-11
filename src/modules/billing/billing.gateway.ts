import { Server } from 'socket.io';
import {
  getRedis,
  callSessionKey,
  callUserCoinsKey,
  callCreatorEarningsKey,
  invalidateCreatorDashboard,
  invalidateAdminCaches,
} from '../../config/redis';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { CallHistory } from './call-history.model';
import { randomUUID } from 'crypto';
import { emitCreatorDataUpdated } from '../creator/creator.controller';

// ── Constants ─────────────────────────────────────────────────────────────
const CREATOR_EARNINGS_PER_SECOND = 0.3; // Creator earns 0.30 coins/sec (18 coins/min)
const CALL_SESSION_TTL = 7200; // 2-hour TTL safety net for Redis keys

// ── In-memory interval registry ───────────────────────────────────────────
const activeBillingIntervals: Map<string, NodeJS.Timeout> = new Map();

// ── Map firebaseUid → callId for disconnect-based settlement ─────────────
const activeCallsByUser: Map<string, string> = new Map();

// ── Deferred call-end tracking ────────────────────────────────────────────
// When `call:ended` arrives BEFORE `handleCallStarted` finishes writing the
// Redis session, we can't settle yet.  Store the callId here so that once
// `handleCallStarted` completes it can settle immediately.
const pendingCallEnds = new Set<string>();

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
    console.log(`💰 [BILLING] ${firebaseUid} joined room user:${firebaseUid}`);

    // ── call:started ────────────────────────────────────────────────
    socket.on(
      'call:started',
      async (data: {
        callId: string;
        creatorFirebaseUid: string;
        creatorMongoId: string;
      }) => {
        try {
          console.log(`💰 [BILLING] call:started received for ${data.callId}`);
          await handleCallStarted(io, firebaseUid, data);

          // If call:ended arrived while we were setting up, settle now
          if (pendingCallEnds.has(data.callId)) {
            pendingCallEnds.delete(data.callId);
            console.log(`💰 [BILLING] Deferred settlement for ${data.callId}`);
            await settleCall(io, data.callId);
          }
        } catch (err) {
          console.error('❌ [BILLING] Error in call:started:', err);
          // Clean up pending end if start failed
          pendingCallEnds.delete(data.callId);
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
        console.log(`💰 [BILLING] call:ended received for ${data.callId}`);

        // Check if the session exists yet (handleCallStarted may still be running)
        const redis = getRedis();
        const sessionExists = await redis.get(callSessionKey(data.callId));

        if (!sessionExists && !activeBillingIntervals.has(data.callId)) {
          // Session not created yet — defer settlement until handleCallStarted finishes
          pendingCallEnds.add(data.callId);
          console.log(`⏳ [BILLING] Deferring call:ended for ${data.callId} (session not ready)`);
          // Safety: clean up after 60s in case call:started never completes
          setTimeout(() => pendingCallEnds.delete(data.callId), 60_000);
          return;
        }

        await settleCall(io, data.callId);
      } catch (err) {
        console.error('❌ [BILLING] Error in call:ended:', err);
      }
    });

    // ── Auto-settle on disconnect ─────────────────────────────────
    // If this socket was part of an active billing session, settle
    // immediately so coins stop being deducted.  settleCall is
    // idempotent — duplicate calls are safe.
    socket.on('disconnect', async (reason) => {
      console.log(`💰 [BILLING] Socket disconnected: ${firebaseUid} (${reason})`);
      const callId = activeCallsByUser.get(firebaseUid);
      if (callId) {
        console.log(`💰 [BILLING] Auto-settling call ${callId} due to disconnect of ${firebaseUid}`);
        try {
          await settleCall(io, callId);
        } catch (err) {
          console.error(`❌ [BILLING] Auto-settle failed for ${callId}:`, err);
        }
      }
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
// CALL LIFECYCLE
// ══════════════════════════════════════════════════════════════════════════

async function handleCallStarted(
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
    console.log(`⚠️  [BILLING] Session already exists for call ${callId}`);
    return;
  }

  // Fetch user from Mongo
  const user = await User.findOne({ firebaseUid: userFirebaseUid });
  if (!user) throw new Error(`User not found: ${userFirebaseUid}`);

  // Fetch creator to get price per minute
  const creator = await Creator.findById(creatorMongoId);
  if (!creator) throw new Error(`Creator not found: ${creatorMongoId}`);

  const pricePerMinute = creator.price; // e.g. 60 coins/min
  const pricePerSecond = pricePerMinute / 60; // e.g. 1 coin/sec

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
    creatorMongoId,
    pricePerMinute,
    pricePerSecond,
    startTime: Date.now(),
    elapsedSeconds: 0,
  };

  // Seed Redis (3 keys per call)
  await Promise.all([
    redis.set(callSessionKey(callId), JSON.stringify(session), {
      ex: CALL_SESSION_TTL,
    }),
    redis.set(callUserCoinsKey(callId), user.coins.toString(), {
      ex: CALL_SESSION_TTL,
    }),
    redis.set(callCreatorEarningsKey(callId), '0', {
      ex: CALL_SESSION_TTL,
    }),
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

  // Track both participants so we can auto-settle on socket disconnect
  activeCallsByUser.set(userFirebaseUid, callId);
  activeCallsByUser.set(creatorFirebaseUid, callId);

  // Start the 1-second billing loop
  startBillingLoop(io, callId);

  console.log(
    `💰 [BILLING] Session started: call=${callId}  rate=${pricePerSecond}/sec  userCoins=${user.coins}  maxSec=${maxSeconds}`
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 1-SECOND BILLING LOOP
// ══════════════════════════════════════════════════════════════════════════

function startBillingLoop(io: Server, callId: string): void {
  // Clear stale interval if any
  const existing = activeBillingIntervals.get(callId);
  if (existing) clearInterval(existing);

  const interval = setInterval(async () => {
    try {
      await processBillingTick(io, callId);
    } catch (err) {
      console.error(`❌ [BILLING] Tick error for ${callId}:`, err);
      // If we fail 3 consecutive ticks the TTL on Redis will eventually
      // expire the session.  Don't stop the loop on transient errors.
    }
  }, 1000);

  activeBillingIntervals.set(callId, interval);
}

function stopBillingLoop(callId: string): void {
  const interval = activeBillingIntervals.get(callId);
  if (interval) {
    clearInterval(interval);
    activeBillingIntervals.delete(callId);
    console.log(`⏹️  [BILLING] Stopped loop for ${callId}`);
  }
}

async function processBillingTick(
  io: Server,
  callId: string
): Promise<void> {
  const redis = getRedis();

  // ── Read session ────────────────────────────────────────────────────
  const sessionRaw = await redis.get<string>(callSessionKey(callId));
  if (!sessionRaw) {
    stopBillingLoop(callId);
    return;
  }

  const session: CallSession =
    typeof sessionRaw === 'string' ? JSON.parse(sessionRaw) : (sessionRaw as any);

  // ── Read current coins & earnings ──────────────────────────────────
  const [coinsRaw, earningsRaw] = await Promise.all([
    redis.get<string>(callUserCoinsKey(callId)),
    redis.get<string>(callCreatorEarningsKey(callId)),
  ]);

  if (coinsRaw === null) {
    stopBillingLoop(callId);
    return;
  }

  let coins = parseFloat(coinsRaw as string);
  let earnings = parseFloat((earningsRaw as string) || '0');
  const deduction = session.pricePerSecond;

  // ── Check affordability ────────────────────────────────────────────
  if (coins < deduction) {
    console.log(
      `💰 [BILLING] User out of coins for call ${callId} (has ${coins}, needs ${deduction}). Force-ending.`
    );

    io.to(`user:${session.userFirebaseUid}`).emit('call:force-end', {
      callId,
      reason: 'insufficient_coins',
      remainingCoins: Math.floor(coins),
    });
    io.to(`user:${session.creatorFirebaseUid}`).emit('call:force-end', {
      callId,
      reason: 'user_out_of_coins',
    });

    await settleCall(io, callId);
    return;
  }

  // ── Apply tick ─────────────────────────────────────────────────────
  coins -= deduction;
  earnings += CREATOR_EARNINGS_PER_SECOND;
  session.elapsedSeconds += 1;

  // ── Persist to Redis ───────────────────────────────────────────────
  await Promise.all([
    redis.set(callUserCoinsKey(callId), coins.toString(), {
      ex: CALL_SESSION_TTL,
    }),
    redis.set(callCreatorEarningsKey(callId), earnings.toString(), {
      ex: CALL_SESSION_TTL,
    }),
    redis.set(callSessionKey(callId), JSON.stringify(session), {
      ex: CALL_SESSION_TTL,
    }),
  ]);

  const remainingSeconds = Math.floor(coins / session.pricePerSecond);

  // ── Emit live updates ──────────────────────────────────────────────
  io.to(`user:${session.userFirebaseUid}`).emit('billing:update', {
    callId,
    coins: Math.floor(coins),
    coinsExact: parseFloat(coins.toFixed(4)),
    elapsedSeconds: session.elapsedSeconds,
    remainingSeconds,
  });

  io.to(`user:${session.creatorFirebaseUid}`).emit('billing:update', {
    callId,
    earnings: parseFloat(earnings.toFixed(2)),
    elapsedSeconds: session.elapsedSeconds,
  });
}

// ══════════════════════════════════════════════════════════════════════════
// SETTLEMENT — the ONLY place that writes to MongoDB for billing
// ══════════════════════════════════════════════════════════════════════════

async function settleCall(io: Server, callId: string): Promise<void> {
  // Stop loop immediately
  stopBillingLoop(callId);

  const redis = getRedis();

  // ── Read final state from Redis ────────────────────────────────────
  const sessionRaw = await redis.get<string>(callSessionKey(callId));
  if (!sessionRaw) {
    console.log(`⚠️  [BILLING] No session to settle for ${callId}`);
    return;
  }

  const session: CallSession =
    typeof sessionRaw === 'string' ? JSON.parse(sessionRaw) : (sessionRaw as any);

  const [finalCoinsRaw, finalEarningsRaw] = await Promise.all([
    redis.get<string>(callUserCoinsKey(callId)),
    redis.get<string>(callCreatorEarningsKey(callId)),
  ]);

  const finalCoins = parseFloat((finalCoinsRaw as string) || '0');
  const finalEarnings = parseFloat((finalEarningsRaw as string) || '0');
  const totalDeducted = session.elapsedSeconds * session.pricePerSecond;

  console.log(
    `💰 [BILLING] Settling call ${callId}: ` +
      `${session.elapsedSeconds}s elapsed, ` +
      `deducted ~${totalDeducted.toFixed(2)} coins, ` +
      `creator earned ${finalEarnings.toFixed(2)}`
  );

  try {
    // 1️⃣  Update user coin balance in MongoDB
    const user = await User.findById(session.userMongoId);
    if (user) {
      user.coins = Math.max(0, Math.floor(finalCoins));
      await user.save();
    }

    // 2️⃣  Write debit transaction for user
    if (totalDeducted > 0) {
      await new CoinTransaction({
        transactionId: `call_debit_${callId}_${randomUUID()}`,
        userId: session.userMongoId,
        type: 'debit',
        coins: Math.ceil(totalDeducted),
        source: 'video_call',
        description: `Video call (${session.elapsedSeconds}s) @ ${session.pricePerMinute} coins/min`,
        callId,
        status: 'completed',
      }).save();
    }

    // 3️⃣  Credit creator's coin balance + write credit transaction
    if (finalEarnings > 0) {
      const creator = await Creator.findById(session.creatorMongoId);
      if (creator) {
        const creatorUser = await User.findById(creator.userId);
        if (creatorUser) {
          creatorUser.coins = (creatorUser.coins || 0) + Math.floor(finalEarnings);
          await creatorUser.save();

          await new CoinTransaction({
            transactionId: `call_credit_${callId}_${randomUUID()}`,
            userId: creator.userId,
            type: 'credit',
            coins: Math.floor(finalEarnings),
            source: 'video_call',
            description: `Earned from video call (${session.elapsedSeconds}s)`,
            callId,
            status: 'completed',
          }).save();
        }
      }
    }

    // 4️⃣  Save call history records (one per party) ─────────────
    try {
      const creatorDoc = await Creator.findById(session.creatorMongoId);
      const userDoc = await User.findById(session.userMongoId);
      const creatorUserDoc = creatorDoc
        ? await User.findById(creatorDoc.userId)
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
          otherName: creatorName,
          otherAvatar: creatorAvatar,
          otherFirebaseUid: creatorFirebaseUid,
          ownerRole: 'user',
          durationSeconds: session.elapsedSeconds,
          coinsDeducted: Math.ceil(totalDeducted),
          coinsEarned: 0,
        },
        { upsert: true, new: true }
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
          { upsert: true, new: true }
        );
      }

      console.log(`📋 [BILLING] Call history saved for ${callId}`);
    } catch (historyErr) {
      // Non-fatal — billing settlement still succeeded
      console.error(
        `⚠️ [BILLING] Failed to save call history for ${callId}:`,
        historyErr
      );
    }

    // 5️⃣  Notify both parties of final settlement
    io.to(`user:${session.userFirebaseUid}`).emit('billing:settled', {
      callId,
      finalCoins: Math.floor(finalCoins),
      totalDeducted: Math.ceil(totalDeducted),
      durationSeconds: session.elapsedSeconds,
    });

    io.to(`user:${session.creatorFirebaseUid}`).emit('billing:settled', {
      callId,
      totalEarned: Math.floor(finalEarnings),
      durationSeconds: session.elapsedSeconds,
    });

    // 6️⃣  Invalidate creator dashboard cache + emit real-time update
    try {
      const creatorDoc2 = await Creator.findById(session.creatorMongoId);
      if (creatorDoc2) {
        await invalidateCreatorDashboard(creatorDoc2.userId.toString());
        emitCreatorDataUpdated(session.creatorFirebaseUid, {
          reason: 'call_settled',
          callId,
          totalEarned: Math.floor(finalEarnings),
          durationSeconds: session.elapsedSeconds,
        });
      }
      // Invalidate admin caches after call settlement
      await invalidateAdminCaches('overview', 'coins', 'creators_performance');
    } catch (cacheErr) {
      console.error(`⚠️ [BILLING] Failed to invalidate creator cache for ${callId}:`, cacheErr);
    }

    console.log(`✅ [BILLING] Settlement complete for call ${callId}`);
  } catch (err) {
    console.error(`❌ [BILLING] Settlement failed for ${callId}:`, err);
  } finally {
    // 6️⃣  Clean up Redis keys no matter what
    await Promise.all([
      redis.del(callSessionKey(callId)),
      redis.del(callUserCoinsKey(callId)),
      redis.del(callCreatorEarningsKey(callId)),
    ]);

    // 7️⃣  Clean up user → call tracking
    activeCallsByUser.delete(session.userFirebaseUid);
    activeCallsByUser.delete(session.creatorFirebaseUid);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// CLEANUP (called on server shutdown)
// ══════════════════════════════════════════════════════════════════════════
export function cleanupBillingIntervals(): void {
  for (const [callId, interval] of activeBillingIntervals.entries()) {
    clearInterval(interval);
    console.log(`🧹 [BILLING] Cleaned up interval for ${callId}`);
  }
  activeBillingIntervals.clear();
  activeCallsByUser.clear();
  pendingCallEnds.clear();
}
