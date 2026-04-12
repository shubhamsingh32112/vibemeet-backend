import type { Request, Response } from 'express';
import { callLifecycleService } from './call-lifecycle.service';
import type { StreamVideoWebhookPayload } from './call-lifecycle.service';
import { logError, logInfo } from '../../utils/logger';
import { recordCallMetric } from '../../utils/monitoring';
import { Call } from './call.model';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { getStreamClient } from '../../config/stream';

function parseStreamVideoWebhookPayload(req: Request): StreamVideoWebhookPayload {
  if (Buffer.isBuffer(req.body)) {
    const raw = req.body as Buffer;
    const s = raw.toString('utf8');
    if (!s?.trim()) {
      return {} as StreamVideoWebhookPayload;
    }
    return JSON.parse(s) as StreamVideoWebhookPayload;
  }
  return (req.body || {}) as StreamVideoWebhookPayload;
}

function webhookLogContext(payload: StreamVideoWebhookPayload): Record<string, string | undefined> {
  const callId = payload.call?.id ?? payload.call_cid?.split(':')[1];
  const eventIdParts = [
    payload.type || 'unknown',
    payload.call_cid || payload.call?.id || 'no-call',
    payload.session_id || payload.session?.id || 'no-session',
    payload.created_at || '',
  ];
  return {
    webhookType: payload.type,
    callId: callId || undefined,
    eventId: eventIdParts.join(':'),
  };
}

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
  let payload: StreamVideoWebhookPayload;
  try {
    payload = parseStreamVideoWebhookPayload(req);
  } catch (e) {
    logError('Invalid Stream Video webhook JSON', e, { path: req.path });
    res.status(400).json({ success: false, error: 'Invalid JSON body' });
    return;
  }

  try {
    logInfo('Received Stream Video webhook', { type: payload?.type });

    res.status(200).json({ success: true });

    const webhookType = String(payload?.type ?? 'unknown');

    // Process asynchronously so HTTP latency stays low for Stream.
    setImmediate(async () => {
      try {
        const shouldProcess = await callLifecycleService.persistAndApplyIdempotency(payload);
        if (!shouldProcess) {
          recordCallMetric('webhook_async_duplicate', 1, { type: webhookType });
          return;
        }

        await callLifecycleService.routeEvent(payload);
        recordCallMetric('webhook_async_success', 1, { type: webhookType });
      } catch (error) {
        recordCallMetric('webhook_async_error', 1, { type: webhookType });
        logError('Error processing webhook asynchronously', error, webhookLogContext(payload));
      }
    });
  } catch (error) {
    logError('Error in webhook HTTP handler', error);
    res.status(200).json({ success: true, error: 'Processing error (logged)' });
  }
};

// Event-specific handlers: call.ringing, call.accepted, call.session_started, call.session_ended
// are in CallLifecycleService. This file: HTTP handler + cleanup helpers.

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
 * Clears Stream Chat `busy` for all creator users (expensive). Not used on graceful shutdown.
 * Kept for manual/emergency scripts if Stream Chat presence drifts from Redis.
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
