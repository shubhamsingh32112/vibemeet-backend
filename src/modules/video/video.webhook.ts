import type { Request, Response } from 'express';
import axios from 'axios';
import mongoose from 'mongoose';
import { Call } from './call.model';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { generateServerSideToken } from '../../config/stream-video';
import { getStreamClient } from '../../config/stream';
import { setAvailability } from '../availability/availability.service';
import { emitCreatorStatus } from '../availability/availability.socket';

/**
 * Stream Video webhook handler for call lifecycle events
 * 
 * This is the AUTHORITATIVE layer for call billing and state management.
 * Client disconnect ≠ call ended - we rely on Stream webhooks for truth.
 * 
 * Webhook endpoint: POST /api/v1/video/webhook
 * 
 * Stream will call this on:
 * - call.ended: Call was ended
 * - call.session_started: Call session actually started (both participants joined)
 * - call.session_ended: Call session ended
 * - call.ringing: Call is ringing (if available)
 */

interface StreamVideoWebhookPayload {
  type: string;
  call?: {
    id: string;
    type: string;
    cid: string;
    created_by?: {
      id: string;
    };
    settings?: {
      max_participants?: number;
    };
    members?: Array<{
      user_id: string;
      role?: string;
    }>;
  };
  call_cid?: string;
  session_id?: string;
  session?: {
    id: string;
    started_at?: string;
    ended_at?: string;
    participants?: Array<{
      user_id: string;
      role?: string;
    }>;
  };
  created_at?: string;
}

/**
 * PHASE 3: Per-second billing engine
 * 
 * Active billing intervals stored in memory
 * Key: callId, Value: NodeJS.Timeout
 * 
 * PHASE 9: Also track last billing heartbeat for watchdog
 */
const activeBillingIntervals = new Map<string, NodeJS.Timeout>();
const billingHeartbeats = new Map<string, number>(); // callId -> last heartbeat timestamp
const MAX_CALL_DURATION_SECONDS = 3600; // PHASE 9: Hard cap at 1 hour (optional safety guard)

/**
 * PHASE 3: Start per-second billing for a call
 */
async function startPerSecondBilling(callId: string): Promise<void> {
  // Check if billing already started for this call
  if (activeBillingIntervals.has(callId)) {
    console.log(`⚠️  [BILLING] Billing already started for call ${callId}`);
    return;
  }

  console.log(`💰 [BILLING] Starting per-second billing for call ${callId}`);

  // PHASE 9: Initialize heartbeat
  billingHeartbeats.set(callId, Date.now());
  
  // Create interval that runs every 1 second
  const interval = setInterval(async () => {
    try {
      // PHASE 9: Update heartbeat
      billingHeartbeats.set(callId, Date.now());
      
      await processPerSecondBilling(callId);
    } catch (error) {
      console.error(`❌ [BILLING] Error in per-second billing for ${callId}:`, error);
      // PHASE 9: If billing loop crashes, end the call
      console.error(`🛑 [BILLING] Billing loop crashed for ${callId}, ending call`);
      await forceEndCall(callId, 'BILLING_ERROR');
      stopPerSecondBilling(callId);
    }
  }, 1000); // Every 1 second

  // Store interval so we can clear it later
  activeBillingIntervals.set(callId, interval);
  
  // PHASE 9: Start watchdog to detect stuck billing loops
  startBillingWatchdog(callId);
}

/**
 * PHASE 3: Stop per-second billing for a call
 */
function stopPerSecondBilling(callId: string): void {
  const interval = activeBillingIntervals.get(callId);
  if (interval) {
    clearInterval(interval);
    activeBillingIntervals.delete(callId);
    billingHeartbeats.delete(callId); // PHASE 9: Clean up heartbeat
    console.log(`🛑 [BILLING] Stopped per-second billing for call ${callId}`);
  }
}

/**
 * PHASE 9: Billing heartbeat watchdog
 * 
 * Detects if billing loop is stuck (no heartbeat for 10 seconds)
 * If stuck, force-ends the call to prevent infinite billing
 */
async function startBillingWatchdog(callId: string): Promise<void> {
  const watchdogInterval = setInterval(async () => {
    const lastHeartbeat = billingHeartbeats.get(callId);
    
    if (!lastHeartbeat) {
      // Billing already stopped
      clearInterval(watchdogInterval);
      return;
    }
    
    const timeSinceHeartbeat = Date.now() - lastHeartbeat;
    
    // If no heartbeat for 10 seconds, billing loop is stuck
    if (timeSinceHeartbeat > 10000) {
      console.error(`🚨 [BILLING WATCHDOG] Billing loop stuck for ${callId} (no heartbeat for ${timeSinceHeartbeat}ms)`);
      await forceEndCall(callId, 'BILLING_WATCHDOG_TIMEOUT');
      stopPerSecondBilling(callId);
      clearInterval(watchdogInterval);
    }
  }, 5000); // Check every 5 seconds
}

/**
 * PHASE 3: Process one second of billing
 * Uses DB transaction to avoid double billing
 */
async function processPerSecondBilling(callId: string): Promise<void> {
  // Use transaction to ensure atomicity
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Reload call, user, and creator from DB (fresh data)
    const call = await Call.findOne({ callId }).session(session);
    if (!call) {
      await session.abortTransaction();
      await session.endSession();
      stopPerSecondBilling(callId);
      return;
    }

    // Check if call is still active
    if (call.status !== 'accepted' || call.isSettled) {
      await session.abortTransaction();
      await session.endSession();
      stopPerSecondBilling(callId);
      return;
    }

    // Reload user to get fresh coin balance
    const caller = await User.findById(call.callerUserId).session(session);
    if (!caller) {
      await session.abortTransaction();
      await session.endSession();
      console.error(`❌ [BILLING] Caller not found: ${call.callerUserId}`);
      return;
    }

    // Check if user has coins
    if (caller.coins <= 0) {
      await session.abortTransaction();
      await session.endSession();
      
      // PHASE 8: Force end the call with standardized error code
      await forceEndCall(callId, 'INSUFFICIENT_COINS_CALL');
      
      // Mark call as force-ended
      call.isForceEnded = true;
      call.status = 'ended';
      call.endedAt = new Date();
      await call.save();
      
      stopPerSecondBilling(callId);
      return;
    }

    // Get creator
    const creator = await Creator.findOne({ userId: call.creatorUserId }).session(session);
    if (!creator) {
      await session.abortTransaction();
      await session.endSession();
      console.error(`❌ [BILLING] Creator not found: ${call.creatorUserId}`);
      return;
    }

    // PHASE 9: Deduct 1 coin from user (ensure floor = 0)
    caller.coins = Math.max(0, caller.coins - 1);
    await caller.save({ session });

    // Add 0.3 coins to creator earnings (integer rounding)
    creator.earningsCoins = (creator.earningsCoins || 0) + 0.3;
    await creator.save({ session });

    // PHASE 9: Hard cap on call duration (optional safety guard)
    const newBilledSeconds = (call.billedSeconds || 0) + 1;
    if (newBilledSeconds >= MAX_CALL_DURATION_SECONDS) {
      await session.commitTransaction();
      await session.endSession();
      
      console.log(`⏰ [BILLING] Call ${callId} reached max duration (${MAX_CALL_DURATION_SECONDS}s), ending call`);
      await forceEndCall(callId, 'MAX_DURATION_REACHED');
      
      call.isForceEnded = true;
      call.status = 'ended';
      call.endedAt = new Date();
      await call.save();
      
      stopPerSecondBilling(callId);
      return;
    }
    
    // PHASE 9: Ensure coin balance never goes negative (floor = 0)
    caller.coins = Math.max(0, caller.coins);
    
    // Update call record
    call.billedSeconds = newBilledSeconds;
    call.userCoinsSpent = (call.userCoinsSpent || 0) + 1;
    call.creatorCoinsEarned = (call.creatorCoinsEarned || 0) + 0.3;
    await call.save({ session });

    // Commit transaction
    await session.commitTransaction();
    await session.endSession();

    // Log every 10 seconds to avoid spam
    if (call.billedSeconds % 10 === 0) {
      console.log(`💰 [BILLING] Call ${callId}: ${call.billedSeconds}s billed, user has ${caller.coins} coins remaining`);
    }
  } catch (error) {
    await session.abortTransaction();
    await session.endSession();
    console.error(`❌ [BILLING] Transaction error for call ${callId}:`, error);
    throw error;
  }
}

/**
 * PHASE 3: Force-end call via Stream Video API
 * 
 * Uses Stream Video REST API to end the call with a specific reason.
 * This will trigger the call.ended webhook which will finalize billing.
 */
async function forceEndCall(callId: string, reason: string): Promise<void> {
  try {
    const apiKey = process.env.STREAM_API_KEY;
    if (!apiKey) {
      console.error('❌ [BILLING] STREAM_API_KEY not configured');
      return;
    }
    
    const serverToken = generateServerSideToken();
    const callType = 'default';

    // Stream Video API endpoint to end a call
    // Format: POST /v1/calls/{callType}/{callId}/mark_ended
    const streamApiUrl = `https://video.stream-io-api.com/v1/calls/${callType}/${callId}/mark_ended?api_key=${apiKey}`;

    console.log(`🛑 [BILLING] Force-ending call ${callId} via Stream API (reason: ${reason})`);

    await axios.post(
      streamApiUrl,
      {
        reason: reason, // "INSUFFICIENT_COINS"
      },
      {
        headers: {
          Authorization: `Bearer ${serverToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(`✅ [BILLING] Call ${callId} force-ended successfully`);
  } catch (error: any) {
    console.error(`❌ [BILLING] Error force-ending call ${callId}:`, error.response?.data || error.message);
    // Don't throw - we still want to mark the call as ended in DB
    // The call will be finalized when call.ended webhook is received
  }
}

/**
 * Handle Stream Video webhook events
 */
export const handleStreamVideoWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = req.body as StreamVideoWebhookPayload;
    
    console.log(`📥 [VIDEO WEBHOOK] Received webhook: ${payload.type}`);
    
    // Handle call.ended event (call was ended)
    if (payload.type === 'call.ended') {
      await handleCallEnded(payload);
      res.status(200).json({ success: true });
      return;
    }
    
    // Handle call.session_started event (both participants joined)
    if (payload.type === 'call.session_started') {
      await handleSessionStarted(payload);
      res.status(200).json({ success: true });
      return;
    }
    
    // Handle call.session_ended event (session ended)
    if (payload.type === 'call.session_ended') {
      await handleSessionEnded(payload);
      res.status(200).json({ success: true });
      return;
    }
    
    // Handle call.ringing event (call is ringing - mark creator as busy)
    // FIX 4: Mark creator busy at ringing, not session_started
    if (payload.type === 'call.ringing' || payload.type === 'call.created') {
      await handleCallRinging(payload);
      res.status(200).json({ success: true });
      return;
    }
    
    // Handle call.accepted event (call was accepted - mark creator as busy if not already)
    // FIX 4: Fallback if call.ringing is not emitted
    if (payload.type === 'call.accepted') {
      await handleCallAccepted(payload);
      res.status(200).json({ success: true });
      return;
    }
    
    // For other webhook types, just acknowledge
    console.log(`ℹ️  [VIDEO WEBHOOK] Unhandled webhook type: ${payload.type}`);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ [VIDEO WEBHOOK] Error processing webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Handle call.ended event
 * 
 * This is triggered when a call is marked as ended.
 * We need to check the disconnect reason to determine if billing should occur.
 * 
 * Billing should trigger on:
 * - DisconnectReasonEnded
 * - DisconnectReasonCancelled
 * - DisconnectReasonLastParticipantLeft
 * 
 * Never bill on:
 * - DisconnectReasonRejected
 * - DisconnectReasonTimeout
 * - DisconnectReasonFailure
 */
async function handleCallEnded(payload: StreamVideoWebhookPayload): Promise<void> {
  const callId = payload.call?.id || payload.call_cid?.split(':')[1];
  
  if (!callId) {
    console.error('❌ [VIDEO WEBHOOK] call.ended missing call ID');
    return;
  }
  
  console.log(`📞 [VIDEO WEBHOOK] Call ended: ${callId}`);
  
  // PHASE 3: Stop per-second billing if still running
  stopPerSecondBilling(callId);
  
  // Find call record
  const call = await Call.findOne({ callId });
  if (!call) {
    console.log(`⚠️  [VIDEO WEBHOOK] Call record not found: ${callId}`);
    return;
  }
  
  // Update call status
  call.status = 'ended';
  call.endedAt = new Date();
  
  // Calculate duration if we have startedAt
  if (call.startedAt && call.endedAt) {
    call.durationSeconds = Math.floor((call.endedAt.getTime() - call.startedAt.getTime()) / 1000);
  }
  
  // PHASE 4: If not already settled, finalize (billing already happened per second)
  if (!call.isSettled) {
    call.isSettled = true;
  }
  
  // Release creator availability lock
  await releaseCreatorLock(call.creatorUserId.toString());
  
  // 🔥 FIX 4: Check creator's availability toggle before setting status
  try {
    const creatorUser = await User.findById(call.creatorUserId);
    if (creatorUser && creatorUser.firebaseUid) {
      // Get creator profile to check availability toggle
      const creatorProfile = await Creator.findOne({ userId: creatorUser._id });
      
      // 🔥 FIX 4: Only set online if creator's toggle is ON
      // isOnline in Creator model = creator's intent to be available
      const isAvailableToggleOn = creatorProfile?.isOnline === true;
      const newStatus = isAvailableToggleOn ? 'online' : 'busy';
      
      await setAvailability(creatorUser.firebaseUid, newStatus);
      emitCreatorStatus(creatorUser.firebaseUid, newStatus);
      
      console.log(`📡 [AVAILABILITY] Call ended, creator ${creatorUser.firebaseUid} → ${newStatus} (toggle: ${isAvailableToggleOn})`);
      
      // Legacy: Also update Stream Chat for backwards compatibility
      const streamClient = getStreamClient();
      await streamClient.partialUpdateUser({
        id: creatorUser.firebaseUid,
        set: {
          busy: false, // Creator is no longer on a call
        },
      });
    }
  } catch (error) {
    console.error(`⚠️  [WEBHOOK] Failed to update creator availability:`, error);
    // Don't fail the webhook if update fails
  }
  
  await call.save();
  console.log(`✅ [VIDEO WEBHOOK] Call ${callId} marked as ended`);
}

/**
 * FIX 4: Mark creator as busy (with idempotency check)
 * 
 * Helper function to mark creator busy, checking current state first.
 * Prevents repeated writes and race conditions.
 * 
 * 🔥 NEW: Also emits via Socket.IO for real-time updates to all clients
 */
async function markCreatorBusy(creatorFirebaseUid: string): Promise<boolean> {
  try {
    // 🔥 NEW: Update Socket.IO availability (AUTHORITATIVE)
    setAvailability(creatorFirebaseUid, 'busy');
    emitCreatorStatus(creatorFirebaseUid, 'busy');
    
    // Legacy: Also update Stream Chat for backwards compatibility
    const streamClient = getStreamClient();
    
    // Get current user state to check if already busy
    const currentUser = await streamClient.queryUsers({
      filter: { id: { $eq: creatorFirebaseUid } },
    });
    
    // Idempotency check: only update if not already busy
    if (currentUser.users.length > 0 && currentUser.users[0].busy === true) {
      console.log(`ℹ️  [STREAM] Creator ${creatorFirebaseUid} already busy, skipping update`);
      return false; // Already busy, no update needed
    }
    
    // Mark as busy
    await streamClient.partialUpdateUser({
      id: creatorFirebaseUid,
      set: {
        busy: true,
      },
    });
    console.log(`📡 [STREAM] Creator ${creatorFirebaseUid} marked as busy`);
    return true;
  } catch (error) {
    console.error(`⚠️  [STREAM] Failed to set creator busy state:`, error);
    return false;
  }
}

/**
 * FIX 4: Extract creator Firebase UID from webhook payload
 * 
 * Tries multiple methods:
 * 1. From call members (if available in payload)
 * 2. From call record in DB (if exists)
 * 3. From call ID format (userId_creatorId)
 */
async function extractCreatorFirebaseUid(
  payload: StreamVideoWebhookPayload,
  callId: string
): Promise<string | null> {
  // Method 1: Extract from call members in payload (most reliable)
  if (payload.call?.members) {
    // Creator has role 'call_member', caller has role 'admin'
    const creatorMember = payload.call.members.find(m => m.role === 'call_member');
    if (creatorMember?.user_id) {
      return creatorMember.user_id;
    }
  }
  
  // Method 2: Find from call record in DB
  const call = await Call.findOne({ callId });
  if (call) {
    const creatorUser = await User.findById(call.creatorUserId);
    if (creatorUser?.firebaseUid) {
      return creatorUser.firebaseUid;
    }
  }
  
  // Method 3: Parse from call ID format (userId_creatorId)
  // Note: This assumes callId format is consistent
  // If callId format changes, this will fail
  const parts = callId.split('_');
  if (parts.length >= 2) {
    // Last part should be creator MongoDB ID
    const creatorMongoId = parts[parts.length - 1];
    const creator = await Creator.findById(creatorMongoId);
    if (creator) {
      const creatorUser = await User.findById(creator.userId);
      if (creatorUser?.firebaseUid) {
        return creatorUser.firebaseUid;
      }
    }
  }
  
  return null;
}

/**
 * FIX 4: Handle call.ringing or call.created event
 * 
 * Mark creator as busy when call starts ringing (not when session starts).
 * This prevents call spam and ensures accurate busy state.
 * 
 * Uses webhook payload as authoritative source (not DB).
 */
async function handleCallRinging(payload: StreamVideoWebhookPayload): Promise<void> {
  const callId = payload.call?.id || payload.call_cid?.split(':')[1];
  
  if (!callId) {
    console.error('❌ [VIDEO WEBHOOK] call.ringing missing call ID');
    return;
  }
  
  console.log(`📞 [VIDEO WEBHOOK] Call ringing: ${callId}`);
  
  // Extract creator Firebase UID from webhook payload (authoritative)
  const creatorFirebaseUid = await extractCreatorFirebaseUid(payload, callId);
  if (!creatorFirebaseUid) {
    console.error(`❌ [VIDEO WEBHOOK] Could not extract creator Firebase UID from call ${callId}`);
    return;
  }
  
  // Mark creator as busy (with idempotency check)
  await markCreatorBusy(creatorFirebaseUid);
}

/**
 * FIX 4: Handle call.accepted event
 * 
 * Fallback handler if call.ringing is not emitted.
 * Marks creator as busy when call is accepted.
 */
async function handleCallAccepted(payload: StreamVideoWebhookPayload): Promise<void> {
  const callId = payload.call?.id || payload.call_cid?.split(':')[1];
  
  if (!callId) {
    console.error('❌ [VIDEO WEBHOOK] call.accepted missing call ID');
    return;
  }
  
  console.log(`📞 [VIDEO WEBHOOK] Call accepted: ${callId}`);
  
  // Extract creator Firebase UID from webhook payload (authoritative)
  const creatorFirebaseUid = await extractCreatorFirebaseUid(payload, callId);
  if (!creatorFirebaseUid) {
    console.error(`❌ [VIDEO WEBHOOK] Could not extract creator Firebase UID from call ${callId}`);
    return;
  }
  
  // Mark creator as busy (with idempotency check)
  await markCreatorBusy(creatorFirebaseUid);
}

/**
 * Handle call.session_started event
 * 
 * PHASE 3: This is triggered when both participants have joined the call session.
 * This is when the call actually starts (not when it's created or accepted).
 * 
 * PHASE 9: Webhook idempotency - if billing already started, skip
 * 
 * Initialize call record and start per-second billing.
 * 
 * NOTE: Creator busy state should already be set by handleCallRinging(),
 * but we ensure it's set here as a fallback.
 */
async function handleSessionStarted(payload: StreamVideoWebhookPayload): Promise<void> {
  const callId = payload.call?.id || payload.call_cid?.split(':')[1];
  const sessionId = payload.session_id || payload.session?.id;
  
  if (!callId) {
    console.error('❌ [VIDEO WEBHOOK] call.session_started missing call ID');
    return;
  }
  
  console.log(`📞 [VIDEO WEBHOOK] Session started: ${callId}, session: ${sessionId}`);
  
  // Find call record
  const call = await Call.findOne({ callId });
  if (!call) {
    console.log(`⚠️  [VIDEO WEBHOOK] Call record not found: ${callId}`);
    return;
  }
  
  // PHASE 9: Idempotency check - if billing already started, skip
  if (activeBillingIntervals.has(callId)) {
    console.log(`ℹ️  [VIDEO WEBHOOK] Billing already started for ${callId}, skipping (idempotent)`);
    return;
  }
  
  // PHASE 3: Initialize call record for per-second billing
  call.startedAt = payload.session?.started_at 
    ? new Date(payload.session.started_at) 
    : new Date();
  
  // Ensure call status is 'accepted' if it was ringing
  if (call.status === 'ringing') {
    call.status = 'accepted';
  }
  
  // Initialize billing fields
  call.billedSeconds = 0;
  call.userCoinsSpent = 0;
  call.creatorCoinsEarned = 0;
  call.isSettled = false;
  call.isForceEnded = false;
  
  await call.save();
  console.log(`✅ [VIDEO WEBHOOK] Call ${callId} session started at ${call.startedAt}`);

  // FIX 4: Ensure creator is marked as "busy" in Stream Chat (fallback)
  // This should already be set by handleCallRinging() or handleCallAccepted(),
  // but ensure it's set here too as a safety net
  const creatorUser = await User.findById(call.creatorUserId);
  if (creatorUser && creatorUser.firebaseUid) {
    await markCreatorBusy(creatorUser.firebaseUid);
  }
  
  // PHASE 3: Start per-second billing
  await startPerSecondBilling(callId);
}

/**
 * Handle call.session_ended event
 * 
 * PHASE 4: This is triggered when a call session ends.
 * Finalize call record - do NOT rebill (billing already happened per second).
 */
async function handleSessionEnded(payload: StreamVideoWebhookPayload): Promise<void> {
  const callId = payload.call?.id || payload.call_cid?.split(':')[1];
  const sessionId = payload.session_id || payload.session?.id;
  
  if (!callId) {
    console.error('❌ [VIDEO WEBHOOK] call.session_ended missing call ID');
    return;
  }
  
  console.log(`📞 [VIDEO WEBHOOK] Session ended: ${callId}, session: ${sessionId}`);
  
  // PHASE 3: Stop per-second billing
  stopPerSecondBilling(callId);
  
  // Find call record
  const call = await Call.findOne({ callId });
  if (!call) {
    console.log(`⚠️  [VIDEO WEBHOOK] Call record not found: ${callId}`);
    return;
  }
  
  // PHASE 4: Idempotent check - if already settled, return
  if (call.isSettled) {
    console.log(`ℹ️  [VIDEO WEBHOOK] Call ${callId} already settled, skipping`);
    await releaseCreatorLock(call.creatorUserId.toString());
    return;
  }
  
  // Update endedAt if not already set
  if (!call.endedAt && payload.session?.ended_at) {
    call.endedAt = new Date(payload.session.ended_at);
  } else if (!call.endedAt) {
    call.endedAt = new Date();
  }
  
  // Calculate final duration
  if (call.startedAt && call.endedAt) {
    call.durationSeconds = Math.floor((call.endedAt.getTime() - call.startedAt.getTime()) / 1000);
  }
  
  // PHASE 4: Finalize - ensure billedSeconds is final
  // billedSeconds should already be accurate from per-second billing
  // But ensure it matches durationSeconds if there's any discrepancy
  if (call.durationSeconds && call.billedSeconds !== undefined) {
    // billedSeconds is authoritative (from per-second billing)
    // durationSeconds is for reference only
    console.log(`📊 [VIDEO WEBHOOK] Call ${callId} final stats:`);
    console.log(`   Duration: ${call.durationSeconds}s`);
    console.log(`   Billed: ${call.billedSeconds}s`);
    console.log(`   User spent: ${call.userCoinsSpent} coins`);
    console.log(`   Creator earned: ${call.creatorCoinsEarned} coins`);
  }
  
  // Update status
  if (call.status !== 'ended') {
    call.status = 'ended';
  }
  
  // PHASE 4: Mark as settled (do NOT rebill - billing already happened per second)
  call.isSettled = true;
  
  // Release creator availability lock
  await releaseCreatorLock(call.creatorUserId.toString());
  
  // 🔥 FIX 4: Check creator's availability toggle before setting status
  try {
    const creatorUser = await User.findById(call.creatorUserId);
    if (creatorUser && creatorUser.firebaseUid) {
      // Get creator profile to check availability toggle
      const creatorProfile = await Creator.findOne({ userId: creatorUser._id });
      
      // 🔥 FIX 4: Only set online if creator's toggle is ON
      const isAvailableToggleOn = creatorProfile?.isOnline === true;
      const newStatus = isAvailableToggleOn ? 'online' : 'busy';
      
      await setAvailability(creatorUser.firebaseUid, newStatus);
      emitCreatorStatus(creatorUser.firebaseUid, newStatus);
      
      console.log(`📡 [AVAILABILITY] Session ended, creator ${creatorUser.firebaseUid} → ${newStatus} (toggle: ${isAvailableToggleOn})`);
      
      // Legacy: Also update Stream Chat for backwards compatibility
      const streamClient = getStreamClient();
      await streamClient.partialUpdateUser({
        id: creatorUser.firebaseUid,
        set: {
          busy: false, // Creator is no longer on a call
        },
      });
    }
  } catch (error) {
    console.error(`⚠️  [WEBHOOK] Failed to update creator availability:`, error);
    // Don't fail the webhook if update fails
  }
  
  await call.save();
  console.log(`✅ [VIDEO WEBHOOK] Call ${callId} session ended and settled`);
}

/**
 * Process call billing (LEGACY - replaced by per-second billing)
 * 
 * ⚠️ DEPRECATED: This function is no longer used for active calls.
 * Per-second billing happens in processPerSecondBilling().
 * 
 * This function is kept for backwards compatibility with call.ended events
 * that might not have gone through session_ended.
 */
async function processCallBilling(call: any): Promise<void> {
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
 * Release creator availability lock
 */
async function releaseCreatorLock(creatorUserId: string): Promise<void> {
  try {
    const creator = await Creator.findOne({ userId: creatorUserId });
    if (creator) {
      creator.currentCallId = undefined;
      // Note: We don't automatically set isOnline back to true
      // Creator should manually toggle their online status
      await creator.save();
      console.log(`✅ [VIDEO WEBHOOK] Released creator lock for ${creatorUserId}`);
    }
  } catch (error) {
    console.error(`❌ [VIDEO WEBHOOK] Error releasing creator lock:`, error);
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
