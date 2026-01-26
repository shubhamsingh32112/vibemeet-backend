// Server-side timeout cleanup for ringing calls
// Prevents zombie calls if both apps crash

import { Call, CallStatus } from './call.model';
import { getIO } from '../../socket';
import { User } from '../user/user.model';
import { normalizeId } from '../../utils/id-utils';

const RINGING_TIMEOUT_MS = 35 * 1000; // 35 seconds

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

  // Then run every 10 seconds
  return setInterval(() => {
    cleanupStaleRingingCalls();
  }, 10 * 1000);
}
