// Server-side timeout cleanup for ringing calls
// Prevents zombie calls if both apps crash

import { Call, CallStatus } from './call.model';
import { getIO } from '../../socket';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { normalizeId } from '../../utils/id-utils';

const RINGING_TIMEOUT_MS = 35 * 1000; // 35 seconds
const ACCEPTED_BUDGET_CHECK_INTERVAL_MS = 10 * 1000; // piggyback on existing 10s interval

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/**
 * Auto-end accepted calls that exceed the caller's affordable duration.
 * This is the server-authoritative fix for "call doesn't auto end when coins run out".
 */
export async function cleanupOverBudgetAcceptedCalls(): Promise<void> {
  try {
    const now = Date.now();

    // Only calls with a known budget snapshot are eligible
    const calls = await Call.find({
      status: 'accepted',
      acceptedAt: { $exists: true, $ne: null },
      maxDurationSeconds: { $exists: true, $ne: null },
    }).limit(200);

    if (calls.length === 0) return;

    for (const call of calls) {
      const acceptedAtMs = call.acceptedAt ? call.acceptedAt.getTime() : 0;
      const maxSeconds = call.maxDurationSeconds ?? 0;
      if (acceptedAtMs <= 0 || maxSeconds <= 0) continue;

      const elapsedSeconds = Math.floor((now - acceptedAtMs) / 1000);
      if (elapsedSeconds < maxSeconds) continue;

      // Hard stop: mark ended + settle once.
      const io = getIO();
      const endedAt = new Date();
      const duration = Math.max(0, elapsedSeconds);

      // Load users for notifications/coins
      const caller = await User.findById(call.callerUserId);
      const creator = await User.findById(call.creatorUserId);

      // Idempotency: if already ended, skip
      if (call.status === 'ended') continue;

      // Set terminal status
      call.status = 'ended';
      call.endedAt = endedAt;
      call.duration = duration;

      // Settle coins if not settled yet
      if (!call.isSettled && caller) {
        try {
          const pricePerMinute = call.priceAtCallTime ?? 0;
          let coinsDeducted = 0;

          if (pricePerMinute > 0 && duration > 0) {
            const durationMinutes = duration / 60;
            coinsDeducted = Math.ceil(pricePerMinute * durationMinutes);
            const currentCoins = caller.coins || 0;
            if (coinsDeducted > currentCoins) coinsDeducted = currentCoins;

            caller.coins = Math.max(0, currentCoins - coinsDeducted);
            await caller.save();

            // Emit coins_updated to caller (socket-first UI)
            if (caller.firebaseUid) {
              io.to(caller.firebaseUid).emit('coins_updated', {
                userId: caller._id.toString(),
                coins: caller.coins,
              });
            }

            call.userPaidCoins = coinsDeducted;
            call.isSettled = true;

            // Append transaction (audit trail)
            try {
              const tx = new CoinTransaction({
                transactionId: `call_${call.callId}_autoend_${Date.now()}`,
                userId: caller._id,
                type: 'debit',
                coins: coinsDeducted,
                source: 'video_call',
                description: `Video call (auto-ended: insufficient coins) (${durationMinutes.toFixed(2)} min)`,
                callId: call.callId,
                status: 'completed',
              });
              await tx.save();
            } catch (txError) {
              console.error('⚠️  [CALL CLEANUP] Failed to create coin transaction (auto-end):', txError);
            }
          } else {
            // Legacy: if snapshot missing, try to backfill once from creator profile
            const creatorProfile = await Creator.findOne({ userId: call.creatorUserId });
            if (creatorProfile?.price && creatorProfile.price > 0) {
              call.priceAtCallTime = creatorProfile.price;
            }
          }
        } catch (settleError) {
          console.error('❌ [CALL CLEANUP] Error settling coins for auto-ended call:', settleError);
        }
      }

      await call.save();

      // Emit terminal call_ended to both parties
      const eventData = {
        callId: call.callId,
        status: 'ended',
        endedBy: 'system',
        reason: 'insufficient_coins',
        duration: duration,
        durationFormatted: duration > 0 ? formatDuration(duration) : null,
        endedAt: endedAt.toISOString(),
      };

      if (caller?.firebaseUid) {
        io.to(caller.firebaseUid).emit('call_ended', eventData);
      }
      if (creator?.firebaseUid) {
        io.to(creator.firebaseUid).emit('call_ended', eventData);
      }

      console.log(`🧹 [CALL CLEANUP] Auto-ended call for insufficient coins: ${call.callId}`);
      console.log(`   Caller: ${caller?.firebaseUid || 'unknown'} | Creator: ${creator?.firebaseUid || 'unknown'}`);
      console.log(`   Duration: ${duration}s | Max: ${maxSeconds}s`);
    }
  } catch (error) {
    console.error('❌ [CALL CLEANUP] Error cleaning up over-budget accepted calls:', error);
  }
}

/**
 * Cleanup stale ringing calls
 * Should be called periodically (e.g., every 10 seconds)
 */
export async function cleanupStaleRingingCalls(): Promise<void> {
  try {
    const now = new Date();
    const timeoutThreshold = new Date(now.getTime() - RINGING_TIMEOUT_MS);

    // Find calls that have been ringing for more than 35 seconds
    const staleCalls = await Call.find({
      status: 'ringing',
      createdAt: { $lt: timeoutThreshold },
    });

    if (staleCalls.length > 0) {
      console.log(`🧹 [CALL CLEANUP] Found ${staleCalls.length} stale ringing call(s)`);

      for (const call of staleCalls) {
        const oldStatus = call.status;
        
        // GUARD 1: Check if creator was offline when call was initiated
        // If creator is still offline, mark as missed; otherwise reject
        const creator = await User.findById(call.creatorUserId);
        let isMissed = false;
        
        if (creator?.firebaseUid) {
          try {
            const io = getIO();
            const sockets = await io.in(creator.firebaseUid).allSockets();
            // If creator is still offline, mark as missed
            isMissed = sockets.size === 0;
          } catch (e) {
            // If socket check fails, default to rejected
            console.error('⚠️  [CALL CLEANUP] Error checking creator online status:', e);
          }
        }
        
        call.status = isMissed ? 'rejected' : 'rejected'; // TODO: Add 'missed' status if needed
        await call.save();

        // Emit call_missed or call_rejected to caller
        const caller = await User.findById(call.callerUserId);
        if (caller?.firebaseUid) {
          try {
            const io = getIO();
            const eventName = isMissed ? 'call_missed' : 'call_rejected';
            io.to(caller.firebaseUid).emit(eventName, {
              callId: call.callId,
              status: call.status,
              reason: isMissed ? 'creator_offline' : 'timeout',
            });
            console.log(`📡 [CALL CLEANUP] Emitted ${eventName} to caller: ${caller.firebaseUid}`);
          } catch (e) {
            console.error('⚠️  [CALL CLEANUP] Failed to emit event to caller:', e);
          }
        }

        console.log({
          event: isMissed ? 'call_missed' : 'call_timeout_auto_reject',
          callId: call.callId,
          callerId: normalizeId(call.callerUserId),
          creatorId: normalizeId(call.creatorUserId),
          from: oldStatus,
          to: call.status,
          reason: isMissed ? 'creator_offline' : 'server_timeout',
          timeoutMs: RINGING_TIMEOUT_MS,
        });
      }
    }
  } catch (error) {
    console.error('❌ [CALL CLEANUP] Error cleaning up stale calls:', error);
  }
}

/**
 * Start the cleanup interval
 * Runs every 10 seconds
 */
export function startCallCleanupInterval(): NodeJS.Timeout {
  console.log('🔄 [CALL CLEANUP] Starting call cleanup interval (every 10s)');
  
  // Run immediately on start
  cleanupStaleRingingCalls();
  cleanupOverBudgetAcceptedCalls();

  // Then run every 10 seconds
  return setInterval(() => {
    cleanupStaleRingingCalls();
    cleanupOverBudgetAcceptedCalls();
  }, 10 * 1000);
}
