import type { Request, Response } from 'express';
import { callLifecycleService } from './call-lifecycle.service';
import { logError, logInfo } from '../../utils/logger';
import { Call } from './call.model';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { getStreamClient } from '../../config/stream';
import { CoinTransaction } from '../user/coin-transaction.model';


/**
 * Stream Video webhook HTTP controller.
 *
 * Responsibilities:
 * - Assume request has been authenticated & signature-verified by middleware
 * - Parse & log payload
 * - Acknowledge quickly to Stream (200 OK)
 * - Delegate persistence, idempotency and business logic to CallLifecycleService
 */
export const handleStreamVideoWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = req.body;

    logInfo('Received Stream Video webhook', { type: payload?.type });

    res.status(200).json({ success: true });

    // Process asynchronously so HTTP latency stays low for Stream.
    setImmediate(async () => {
      try {
        const shouldProcess = await callLifecycleService.persistAndApplyIdempotency(
          payload
        );
        if (!shouldProcess) {
          return;
        }

        await callLifecycleService.routeEvent(payload);
      } catch (error) {
        logError('Error processing webhook asynchronously', error, {
          webhookType: payload?.type,
        });
      }
    });
  } catch (error) {
    logError('Error in webhook HTTP handler', error);
    res.status(200).json({ success: true, error: 'Processing error (logged)' });
  }
};

// Note: Event-specific handlers like call.ringing, call.accepted, call.session_started,
// and call.session_ended are now handled in CallLifecycleService (see call-lifecycle.service.ts).
// This file focuses on the HTTP controller and shared helpers (cleanup, legacy billing).

/**
 * Process call billing (LEGACY - replaced by per-second billing)
 * 
 * ⚠️ DEPRECATED: This function is no longer used for active calls.
 * Per-second billing happens in processPerSecondBilling().
 * 
 * This function is kept for backwards compatibility with call.ended events
 * that might not have gone through session_ended.
 */
export async function processCallBilling(call: any): Promise<void> {
  // Skip if already settled
  if (call.isSettled) {
    console.log(`ℹ️  [BILLING] Call ${call.callId} already settled, skipping`);
    return;
  }
  
  // Get caller
  const caller = await User.findById(call.callerUserId);
  if (!caller) {
    console.error(`❌ [BILLING] Caller not found: ${call.callerUserId}`);
    return;
  }
  
  // Get creator
  const creator = await Creator.findOne({ userId: call.creatorUserId });
  if (!creator) {
    console.error(`❌ [BILLING] Creator not found: ${call.creatorUserId}`);
    return;
  }
  
  // PHASE 0: Per-second billing
  // billedSeconds is the authoritative duration (already calculated from startedAt/endedAt)
  const billedSeconds = call.durationSeconds || 0;
  
  if (billedSeconds <= 0) {
    console.log(`ℹ️  [BILLING] Call ${call.callId}: No duration to bill`);
    call.isSettled = true;
    call.billedSeconds = 0;
    call.userCoinsSpent = 0;
    call.creatorCoinsEarned = 0;
    await call.save();
    return;
  }
  
  // User pays: 1 coin per second
  const userCoinsSpent = billedSeconds; // 1 coin per second
  
  // Creator earns: 0.3 coins per second
  const creatorCoinsEarned = Math.floor(billedSeconds * 0.3); // Integer coins
  
  // Don't deduct more than user has
  const actualDeduction = Math.min(userCoinsSpent, caller.coins);
  
  // Check if call was force-ended due to insufficient coins
  const isForceEnded = actualDeduction < userCoinsSpent;
  
  if (actualDeduction <= 0) {
    console.log(`ℹ️  [BILLING] Call ${call.callId}: No coins to deduct (user has ${caller.coins} coins)`);
    call.isSettled = true;
    call.billedSeconds = billedSeconds;
    call.userCoinsSpent = 0;
    call.creatorCoinsEarned = 0;
    call.isForceEnded = true;
    await call.save();
    return;
  }
  
  // Create transaction record BEFORE updating balance (audit trail)
  // Generate unique transaction ID for idempotency
  const transactionId = `call_${call.callId}_${Date.now()}`;
  const transaction = new CoinTransaction({
    transactionId,
    userId: caller._id,
    type: 'debit',
    coins: actualDeduction,
    source: 'video_call',
    description: `Video call with creator (${billedSeconds} seconds @ 1 coin/sec)`,
    callId: call.callId,
    status: 'completed',
  });
  await transaction.save();
  
  // Update caller balance
  const oldCoins = caller.coins;
  caller.coins = Math.max(0, caller.coins - actualDeduction);
  await caller.save();
  
  // Update creator earnings
  creator.earningsCoins = (creator.earningsCoins || 0) + creatorCoinsEarned;
  await creator.save();
  
  // Update call record
  call.billedSeconds = billedSeconds;
  call.userCoinsSpent = actualDeduction;
  call.creatorCoinsEarned = creatorCoinsEarned;
  call.isForceEnded = isForceEnded;
  call.userPaidCoins = actualDeduction; // Legacy field
  call.isSettled = true;
  await call.save();
  
  console.log(`✅ [BILLING] Call ${call.callId} settled`);
  console.log(`   Duration: ${billedSeconds} seconds`);
  console.log(`   User spent: ${actualDeduction} coins (balance: ${oldCoins} → ${caller.coins})`);
  console.log(`   Creator earned: ${creatorCoinsEarned} coins (total: ${creator.earningsCoins})`);
  if (isForceEnded) {
    console.log(`   ⚠️  Call was force-ended due to insufficient coins`);
  }
  
  // TODO: Emit coins_updated socket event if socket.io is available
  // This should be done via the socket service
}

/**
 * 🔥 FIX 6: Cleanup stale creator locks on server startup
 * 
 * Releases locks for calls that no longer exist or are already ended.
 * Prevents creators from being stuck in "busy" state after server crashes.
 */
export async function cleanupStaleCreatorLocks(): Promise<void> {
  try {
    console.log('🧹 [CLEANUP] Starting creator lock cleanup...');
    
    const creators = await Creator.find({ currentCallId: { $exists: true, $ne: null } });
    let cleanedCount = 0;
    
    for (const creator of creators) {
      if (!creator.currentCallId) continue;
      
      // Check if call exists and is still active
      const call = await Call.findOne({ callId: creator.currentCallId });
      
      if (!call || call.status === 'ended' || call.status === 'cancelled' || call.status === 'missed') {
        // Call doesn't exist or is ended - release lock
        creator.currentCallId = undefined;
        await creator.save();
        cleanedCount++;
        console.log(`   ✅ Released stale lock for creator ${creator._id} (call ${creator.currentCallId} not found or ended)`);
      }
    }
    
    console.log(`✅ [CLEANUP] Cleaned up ${cleanedCount} stale creator locks`);
  } catch (error) {
    console.error('❌ [CLEANUP] Error cleaning up creator locks:', error);
    // Don't throw - cleanup shouldn't block server startup
  }
}

/**
 * FIX 4: Clear all creator busy states (process cleanup)
 * 
 * Called on:
 * - Process crash (uncaughtException)
 * - Graceful shutdown (SIGTERM, SIGINT)
 * - Server redeploy
 * 
 * Prevents creators from being stuck in busy: true state.
 */
export async function clearAllCreatorBusyStates(): Promise<void> {
  try {
    console.log('🧹 [CLEANUP] Clearing all creator busy states...');
    
    const streamClient = getStreamClient();
    
    // Find all creators (users with role 'creator')
    const creators = await User.find({ role: 'creator' });
    
    let clearedCount = 0;
    for (const creator of creators) {
      if (creator.firebaseUid) {
        try {
          // Get current user state
          const currentUser = await streamClient.queryUsers({
            filter: { id: { $eq: creator.firebaseUid } },
          });
          
          // Only clear if actually busy
          if (currentUser.users.length > 0 && currentUser.users[0].busy === true) {
            await streamClient.partialUpdateUser({
              id: creator.firebaseUid,
              set: {
                busy: false,
              },
            });
            clearedCount++;
            console.log(`   ✅ Cleared busy state for creator ${creator.firebaseUid}`);
          }
        } catch (error) {
          console.error(`   ⚠️  Failed to clear busy state for creator ${creator.firebaseUid}:`, error);
        }
      }
    }
    
    console.log(`✅ [CLEANUP] Cleared busy state for ${clearedCount} creators`);
  } catch (error) {
    console.error('❌ [CLEANUP] Error clearing creator busy states:', error);
    // Don't throw - this is cleanup, shouldn't block shutdown
  }
}
