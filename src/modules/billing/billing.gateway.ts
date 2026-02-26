import { Server } from 'socket.io';
import { randomUUID } from 'crypto';
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
import { emitCreatorDataUpdated } from '../creator/creator.controller';
import { verifyUserBalance } from '../../utils/balance-integrity';
import { emitToAdmin } from '../admin/admin.gateway';
import { getStreamClient } from '../../config/stream';
import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { runWithRequestContext } from '../../utils/request-context';
import { billingDomainService, BillingLegacySettlementSnapshot } from './billing-domain.service';

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

// ── In-memory settled tracking (extra safety net) ─────────────────────────
// Even with the Redis NX lock, keep a local set so we can skip settlement
// attempts immediately without a Redis round-trip.
const settledCalls = new Set<string>();

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
  if (mins <= 0) return `${secs}s`;
  if (secs <= 0) return `${mins}m`;
  return `${mins}m ${secs}s`;
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

    const withSocketContext = <T>(event: string, callback: () => T): T =>
      runWithRequestContext(
        {
          requestId: `ws-${socket.id}-${event}-${randomUUID()}`,
          source: 'socket',
          path: event,
          socketId: socket.id,
        },
        callback,
      );

    // ── Join personal room so billing can target this user ──────────
    socket.join(`user:${firebaseUid}`);
    withSocketContext('connection', () => {
      logger.info('billing.socket.connected', { firebaseUid });
    });

    // ── call:started ────────────────────────────────────────────────
    socket.on(
      'call:started',
      async (data: {
        callId: string;
        creatorFirebaseUid: string;
        creatorMongoId: string;
      }) => {
        try {
          await withSocketContext('call:started', async () => {
            logger.info('billing.socket.call_started.received', { callId: data.callId, firebaseUid });
            await handleCallStarted(io, firebaseUid, data);
          });

          // If call:ended arrived while we were setting up, settle now
          if (pendingCallEnds.has(data.callId)) {
            pendingCallEnds.delete(data.callId);
            logger.info('billing.socket.call_ended.deferred_settlement', { callId: data.callId });
            await settleCall(io, data.callId);
          }
        } catch (err) {
          logger.error('billing.socket.call_started.failed', { err, callId: data.callId });
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
        await withSocketContext('call:ended', async () => {
          logger.info('billing.socket.call_ended.received', { callId: data.callId, firebaseUid });
        });

        // Check if the session exists yet (handleCallStarted may still be running)
        const redis = getRedis();
        const sessionExists = await redis.get(callSessionKey(data.callId));

        if (!sessionExists && !activeBillingIntervals.has(data.callId)) {
          // Session not created yet — defer settlement until handleCallStarted finishes
          pendingCallEnds.add(data.callId);
          logger.info('billing.socket.call_ended.deferred', { callId: data.callId });
          // Safety: clean up after 60s in case call:started never completes
          setTimeout(() => pendingCallEnds.delete(data.callId), 60_000);
          return;
        }

        await settleCall(io, data.callId);
      } catch (err) {
        logger.error('billing.socket.call_ended.failed', { err, callId: data.callId });
      }
    });

    // ── Auto-settle on disconnect ─────────────────────────────────
    // If this socket was part of an active billing session, settle
    // immediately so coins stop being deducted.  settleCall is
    // idempotent — duplicate calls are safe.
    socket.on('disconnect', async (reason) => {
      withSocketContext('disconnect', () => {
        logger.info('billing.socket.disconnected', { firebaseUid, reason });
      });
      const callId = activeCallsByUser.get(firebaseUid);
      if (callId) {
        logger.info('billing.socket.disconnect_autosettle', { callId, firebaseUid });
        try {
          await settleCall(io, callId);
        } catch (err) {
          logger.error('billing.socket.disconnect_autosettle_failed', { callId, err });
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
  // Try by Creator._id first, then fall back to Creator.userId (User._id)
  // because call history stores the User._id, not the Creator._id.
  let creator = await Creator.findById(creatorMongoId);
  if (!creator) {
    creator = await Creator.findOne({ userId: creatorMongoId });
  }
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

  // Build session — always use the resolved Creator._id so settlement lookups
  // work correctly even when the frontend passed a User._id from call history.
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

  await billingDomainService.onCallStarted({
    callId,
    userFirebaseUid: session.userFirebaseUid,
    creatorFirebaseUid: session.creatorFirebaseUid,
    userMongoId: session.userMongoId,
    creatorMongoId: session.creatorMongoId,
    pricePerMinute: session.pricePerMinute,
    pricePerSecond: session.pricePerSecond,
    startingUserCoins: user.coins,
  });

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

  await billingDomainService.onTick(callId);
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
  await billingDomainService.recordSettlementAttempt();

  // Stop loop immediately
  stopBillingLoop(callId);

  // ── Fast in-memory check ───────────────────────────────────────────
  if (settledCalls.has(callId)) {
    console.log(`⚠️  [BILLING] Call ${callId} already settled (in-memory) — skipping`);
    return;
  }

  const redis = getRedis();

  // ── Atomic settlement lock (NX = only if not exists) ───────────────
  // Only the FIRST caller acquires the lock; every subsequent caller
  // bails out immediately.  The lock expires after 60 s as a safety net.
  const lockAcquired = await redis.set(settleLockKey(callId), '1', {
    nx: true,
    ex: 60,
  });
  if (!lockAcquired) {
    await billingDomainService.recordSettlementConflict(callId, 'legacy_settle_lock_exists');
    console.log(`⚠️  [BILLING] Settlement already in progress / completed for ${callId} — skipping`);
    return;
  }

  // Mark settled in memory so future attempts skip immediately
  settledCalls.add(callId);
  // Clean up from memory after 5 minutes (safety net)
  setTimeout(() => settledCalls.delete(callId), 5 * 60 * 1000);

  // ── Read final state from Redis ────────────────────────────────────
  const sessionRaw = await redis.get<string>(callSessionKey(callId));
  if (!sessionRaw) {
    console.log(`⚠️  [BILLING] No session to settle for ${callId}`);
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
  const finalEarnings = parseFloat((finalEarningsRaw as string) || '0');
  const totalDeducted = session.elapsedSeconds * session.pricePerSecond;
  let legacySnapshot: BillingLegacySettlementSnapshot | null = {
    callId,
    elapsedSeconds: session.elapsedSeconds,
    finalCoins,
    finalEarnings,
    totalDeducted,
  };

  console.log(
    `💰 [BILLING] Settling call ${callId}: ` +
      `${session.elapsedSeconds}s elapsed, ` +
      `deducted ~${totalDeducted.toFixed(2)} coins, ` +
      `creator earned ${finalEarnings.toFixed(2)}`
  );

  // ── Clean up Redis billing keys BEFORE writing to MongoDB ──────────
  // This ensures that even if another settleCall somehow slips through,
  // it will find no session and bail out above.
  await Promise.all([
    redis.del(callSessionKey(callId)),
    redis.del(callUserCoinsKey(callId)),
    redis.del(callCreatorEarningsKey(callId)),
  ]);

  // Clean up user → call tracking immediately
  activeCallsByUser.delete(session.userFirebaseUid);
  activeCallsByUser.delete(session.creatorFirebaseUid);

  try {
    // 1️⃣  Update user coin balance in MongoDB
    const user = await User.findById(session.userMongoId);
    if (user) {
      user.coins = Math.max(0, Math.floor(finalCoins));
      await user.save();

      // Emit coins_updated so the user's UI updates the coin balance
      io.to(`user:${session.userFirebaseUid}`).emit('coins_updated', {
        userId: user._id.toString(),
        coins: user.coins,
      });
    }

    // 2️⃣  Write debit transaction — idempotent by callId
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
        { upsert: true, new: true }
      );
    }

    // 3️⃣  Credit creator's coin balance + write credit transaction
    if (finalEarnings > 0) {
      const creator = await Creator.findById(session.creatorMongoId);
      if (creator) {
        const creatorUser = await User.findById(creator.userId);
        if (creatorUser) {
          creatorUser.coins = (creatorUser.coins || 0) + Math.floor(finalEarnings);
          await creatorUser.save();

          // Idempotent credit transaction by callId
          await CoinTransaction.findOneAndUpdate(
            { callId, userId: creator.userId, type: 'credit' },
            {
              transactionId: `call_credit_${callId}`,
              userId: creator.userId,
              type: 'credit',
              coins: Math.floor(finalEarnings),
              source: 'video_call',
              description: `Earned from video call (${session.elapsedSeconds}s)`,
              callId,
              status: 'completed',
            },
            { upsert: true, new: true }
          );

          // Emit coins_updated so the creator's UI updates the coin balance
          io.to(`user:${session.creatorFirebaseUid}`).emit('coins_updated', {
            userId: creatorUser._id.toString(),
            coins: creatorUser.coins,
          });
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
          otherCreatorId: creatorDoc?._id, // Creator._id for call initiation from Recents
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

        console.log(`💬 [BILLING] Chat call activity message posted for ${callId}`);
      } catch (chatErr) {
        // Non-fatal — settlement remains successful.
        console.error(`⚠️ [BILLING] Failed to post call activity in chat for ${callId}:`, chatErr);
      }
    } catch (historyErr) {
      // Non-fatal — billing settlement still succeeded
      console.error(
        `⚠️ [BILLING] Failed to save call history for ${callId}:`,
        historyErr
      );
    }

    // 5️⃣  Invalidate caches BEFORE emitting events to clients.
    //     This prevents a race where the frontend receives billing:settled,
    //     immediately re-fetches the dashboard, and gets stale cached data
    //     because the cache hasn't been invalidated yet.
    try {
      const creatorDoc2 = await Creator.findById(session.creatorMongoId);
      if (creatorDoc2) {
        await invalidateCreatorDashboard(creatorDoc2.userId.toString());
      }
      await invalidateAdminCaches('overview', 'coins', 'creators_performance');
    } catch (cacheErr) {
      console.error(`⚠️ [BILLING] Failed to invalidate caches for ${callId}:`, cacheErr);
    }

    // 6️⃣  Notify both parties of final settlement
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

    // 7️⃣  Emit real-time creator data update (triggers dashboard re-fetch)
    try {
      const creatorDoc3 = await Creator.findById(session.creatorMongoId);
      if (creatorDoc3) {
        emitCreatorDataUpdated(session.creatorFirebaseUid, {
          reason: 'call_settled',
          callId,
          totalEarned: Math.floor(finalEarnings),
          durationSeconds: session.elapsedSeconds,
        });
      }
    } catch (emitErr) {
      console.error(`⚠️ [BILLING] Failed to emit creator data update for ${callId}:`, emitErr);
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
      creatorEarned: Math.floor(finalEarnings),
    });

    console.log(`✅ [BILLING] Settlement complete for call ${callId}`);
  } catch (err) {
    legacySnapshot = null;
    console.error(`❌ [BILLING] Settlement failed for ${callId}:`, err);
  } finally {
    if (legacySnapshot) {
      await billingDomainService.settleShadowAndCompare({
        ...legacySnapshot,
        totalDeducted: Number(legacySnapshot.totalDeducted.toFixed(4)),
        finalCoins: Number(legacySnapshot.finalCoins.toFixed(4)),
        finalEarnings: Number(legacySnapshot.finalEarnings.toFixed(4)),
        elapsedSeconds: legacySnapshot.elapsedSeconds,
      });
    }

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
  console.log(`🌐 [BILLING HTTP] handleCallStartedHttp for ${data.callId}`);
  await handleCallStarted(io, userFirebaseUid, data);

  // If call:ended arrived while we were setting up, settle now
  if (pendingCallEnds.has(data.callId)) {
    pendingCallEnds.delete(data.callId);
    console.log(`💰 [BILLING HTTP] Deferred settlement for ${data.callId}`);
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
  console.log(`🌐 [BILLING HTTP] settleCallHttp for ${callId}`);

  const redis = getRedis();
  const sessionExists = await redis.get(callSessionKey(callId));

  if (!sessionExists && !activeBillingIntervals.has(callId)) {
    pendingCallEnds.add(callId);
    console.log(`⏳ [BILLING HTTP] Deferring call:ended for ${callId} (session not ready)`);
    setTimeout(() => pendingCallEnds.delete(callId), 60_000);
    return;
  }

  await settleCall(io, callId);
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
  settledCalls.clear();
}
