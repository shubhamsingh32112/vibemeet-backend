import type { Request } from 'express';
import { Response } from 'express';
import mongoose from 'mongoose';
import { Call, CallStatus } from './call.model';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { generateAgoraToken } from '../../utils/agora-token';
import { generateUidFromUserId } from '../../utils/uid-generator';
import { normalizeId, idsMatch, getIdForLogging } from '../../utils/id-utils';
import { getIO } from '../../socket';
import { randomUUID } from 'crypto';

// Structured logging helper
function logCallEvent(event: string, data: Record<string, any>): void {
  console.log(JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    ...data,
  }));
}

// Format duration in seconds to human-readable string
function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

// TASK 2: Backend – Create Call API
export const initiateCall = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('📞 [CALL] Initiate call request');
    
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    const { creatorUserId } = req.body;

    if (!creatorUserId) {
      res.status(400).json({
        success: false,
        error: 'creatorUserId is required',
      });
      return;
    }

    // Get caller (end user)
    const caller = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!caller) {
      res.status(404).json({
        success: false,
        error: 'Caller not found',
      });
      return;
    }

    // Verify caller is end user (not creator)
    if (caller.role === 'creator' || caller.role === 'admin') {
      res.status(403).json({
        success: false,
        error: 'Only end users can initiate calls',
      });
      return;
    }

    // Get creator
    const creator = await User.findById(creatorUserId);
    if (!creator) {
      res.status(404).json({
        success: false,
        error: 'Creator not found',
      });
      return;
    }

    // Verify creator is actually a creator
    if (creator.role !== 'creator' && creator.role !== 'admin') {
      res.status(403).json({
        success: false,
        error: 'Target user is not a creator',
      });
      return;
    }

    // GUARD 1: Ensure caller has enough coins BEFORE creating call or notifying creator
    // This prevents "ghost" incoming calls when the user can't pay.
    const creatorProfile = await Creator.findOne({ userId: creator._id });
    if (!creatorProfile || creatorProfile.price <= 0) {
      console.log(`⚠️  [CALL] Creator profile not found or price not set for initiateCall`);
      res.status(400).json({
        success: false,
        error: 'Creator price is not set. Cannot start call.',
      });
      return;
    }

    const callerCoins = caller.coins || 0;
    const pricePerMinute = creatorProfile.price;

    if (callerCoins < pricePerMinute) {
      console.log(`❌ [CALL] Caller has insufficient coins to initiate call:`);
      console.log(`   Caller coins: ${callerCoins}`);
      console.log(`   Price per minute: ${pricePerMinute}`);
      res.status(402).json({
        success: false,
        error: `Caller has insufficient coins. The caller needs at least ${pricePerMinute} coins to start a call (they have ${callerCoins})`,
        requiredCoins: pricePerMinute,
        currentCoins: callerCoins,
        message: 'You do not have enough coins to start this call.',
      });
      return;
    }

    // GUARD 2: Enforce single active call per user
    // Check if caller has an active call
    const callerActiveCall = await Call.findOne({
      callerUserId: caller._id,
      status: { $in: ['ringing', 'accepted'] as CallStatus[] },
    });

    if (callerActiveCall) {
      logCallEvent('call_initiate_rejected', {
        callId: null,
        callerId: normalizeId(caller._id),
        creatorId: normalizeId(creator._id),
        reason: 'caller_busy',
        existingCallId: callerActiveCall.callId,
      });

      res.status(409).json({
        success: false,
        error: 'You already have an active call',
        message: 'You are already in a call. Please end the current call first.',
      });
      return;
    }

    // Check if creator has an active call
    const creatorActiveCall = await Call.findOne({
      creatorUserId: creator._id,
      status: { $in: ['ringing', 'accepted'] as CallStatus[] },
    });

    if (creatorActiveCall) {
      logCallEvent('call_initiate_rejected', {
        callId: null,
        callerId: normalizeId(caller._id),
        creatorId: normalizeId(creator._id),
        reason: 'creator_busy',
        existingCallId: creatorActiveCall.callId,
      });

      res.status(409).json({
        success: false,
        error: 'Creator is currently in another call',
        message: 'The creator is currently in another call. Please try again later.',
      });
      return;
    }

    // Generate unique call ID and channel name
    const callId = randomUUID();
    const channelName = `call_${callId}`;

    // Create call record with status 'ringing'
    const call = new Call({
      callId,
      channelName,
      callerUserId: caller._id,
      creatorUserId: creator._id,
      status: 'ringing',
    });

    await call.save();

    logCallEvent('call_initiated', {
      callId,
      callerId: normalizeId(caller._id),
      creatorId: normalizeId(creator._id),
      channelName,
      status: 'ringing',
    });

    // GUARD 1: Handle "creator offline" properly
    // Emit incoming call event to creator via Socket.IO
    try {
      const io = getIO();
      const creatorFirebaseUid = creator.firebaseUid || '';
      
      // Check if creator is online (has active socket connection)
      const sockets = await io.in(creatorFirebaseUid).allSockets();
      const isCreatorOnline = sockets.size > 0;
      
      if (isCreatorOnline) {
        // Creator is online - emit immediately
        io.to(creatorFirebaseUid).emit('incoming_call', {
          callId,
          channelName,
          caller: {
            id: normalizeId(caller._id),
            username: caller.username,
            avatar: caller.avatar,
          },
          createdAt: call.createdAt,
        });
        console.log(`📡 [SOCKET] Emitted incoming_call to creator: ${creatorFirebaseUid} (online)`);
      } else {
        // Creator is offline - log for monitoring
        console.log(`⚠️  [SOCKET] Creator offline: ${creatorFirebaseUid}`);
        console.log(`   📞 Call ${callId} will be marked as MISSED after timeout`);
        // Note: Call cleanup will handle marking as missed after timeout
        // This is logged so we can monitor offline rates
      }
    } catch (socketError) {
      // Don't fail the request if socket emit fails
      console.error('⚠️  [SOCKET] Failed to emit incoming_call:', socketError);
    }

    res.json({
      success: true,
      data: {
        callId,
        channelName,
        status: 'ringing',
      },
    });
  } catch (error) {
    console.error('❌ [CALL] Initiate call error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// TASK 4: Backend – Accept Call API
export const acceptCall = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('✅ [CALL] Accept call request');
    
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    const { callId } = req.params;

    // Get creator
    const creator = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!creator) {
      res.status(404).json({
        success: false,
        error: 'Creator not found',
      });
      return;
    }

    // Verify creator is actually a creator
    if (creator.role !== 'creator' && creator.role !== 'admin') {
      res.status(403).json({
        success: false,
        error: 'Only creators can accept calls',
      });
      return;
    }

    // Find call (don't populate for authorization)
    const call = await Call.findOne({ callId });
    if (!call) {
      res.status(404).json({
        success: false,
        error: 'Call not found',
      });
      return;
    }

    // Normalize IDs and validate creator owns this call
    if (!idsMatch(call.creatorUserId, creator._id)) {
      console.error('❌ [CALL] Authorization failed for acceptCall');
      console.error(JSON.stringify({
        authCreator: getIdForLogging(creator._id),
        callCreator: getIdForLogging(call.creatorUserId),
      }, null, 2));
      res.status(403).json({
        success: false,
        error: 'You do not have permission to accept this call',
      });
      return;
    }

    // Check call status
    if (call.status !== 'ringing') {
      res.status(400).json({
        success: false,
        error: `Call is already ${call.status}`,
      });
      return;
    }

    // GUARD 2: Check if creator already has another active call
    const otherActiveCall = await Call.findOne({
      creatorUserId: creator._id,
      status: { $in: ['ringing', 'accepted'] as CallStatus[] },
      callId: { $ne: callId }, // Exclude current call
    });

    if (otherActiveCall) {
      res.status(409).json({
        success: false,
        error: 'You already have an active call',
      });
      return;
    }

    // Get caller to get their firebaseUid for socket emission
    const caller = await User.findById(call.callerUserId);
    if (!caller) {
      res.status(404).json({
        success: false,
        error: 'Caller not found',
      });
      return;
    }

    // 🚨 CRITICAL: Snapshot pricing data at call acceptance (not at call end)
    // This prevents historical billing changes if creator updates price mid-call or later
    const creatorProfile = await Creator.findOne({ userId: creator._id });
    const CREATOR_SHARE_PERCENTAGE = 0.30; // Creator earns 30% of what user pays
    
    if (creatorProfile && creatorProfile.price > 0) {
      const callerCoins = caller.coins || 0;
      const pricePerMinute = creatorProfile.price;
      
      // 🔒 SNAPSHOT: Store pricing data at call acceptance time
      // This ensures billing remains accurate even if price changes later
      call.priceAtCallTime = creatorProfile.price;
      call.creatorShareAtCallTime = CREATOR_SHARE_PERCENTAGE;

      // ✅ Auto-end budget snapshot (server authoritative)
      // Max duration (seconds) such that ceil(pricePerMinute * (seconds/60)) <= callerCoins
      // Sufficient condition: (pricePerMinute * minutes) <= callerCoins  => minutes <= callerCoins/pricePerMinute
      // Use floor seconds to ensure we never exceed caller's budget.
      call.maxDurationSeconds = Math.floor((callerCoins / pricePerMinute) * 60);
      
      // 🚨 CRITICAL: Require at least 1 full minute worth of coins
      // This prevents users from starting calls they can't afford
      // NOTE: This check is for the CALLER's coins, not the creator's
      // Creators don't need coins - they earn coins
      if (callerCoins < pricePerMinute) {
        console.log(`❌ [CALL] Caller has insufficient coins for 1 minute:`);
        console.log(`   Caller coins: ${callerCoins}`);
        console.log(`   Price per minute: ${pricePerMinute}`);
        res.status(402).json({
          success: false,
          error: `Caller has insufficient coins. The caller needs at least ${pricePerMinute} coins to start a call (they have ${callerCoins})`,
          requiredCoins: pricePerMinute,
          currentCoins: callerCoins,
          message: 'The caller does not have enough coins to start this call',
        });
        return;
      }
      
      console.log(`✅ [CALL] Caller has sufficient coins: ${callerCoins} (price: ${pricePerMinute}/min)`);
      console.log(`   Price snapshot: ${pricePerMinute} coins/min`);
      console.log(`   Creator share snapshot: ${(CREATOR_SHARE_PERCENTAGE * 100).toFixed(0)}%`);
      console.log(`   Max duration snapshot: ${call.maxDurationSeconds}s (budget: ${callerCoins} coins)`);
    } else {
      console.log(`⚠️  [CALL] Creator profile not found or price not set`);
      res.status(400).json({
        success: false,
        error: 'Creator price is not set. Cannot start call.',
      });
      return;
    }

    // Generate UID from userId (future-proofing)
    const callerUid = generateUidFromUserId(normalizeId(call.callerUserId));
    const creatorUid = generateUidFromUserId(normalizeId(call.creatorUserId));

    // Generate Agora token
    const tokenExpiry = new Date();
    tokenExpiry.setHours(tokenExpiry.getHours() + 1); // 1 hour expiry

    // Generate tokens for both users (tokens are UID-specific)
    const creatorToken = generateAgoraToken(call.channelName, creatorUid);
    const callerToken = generateAgoraToken(call.channelName, callerUid);

    // Update call status and token (store creator's token for backward compatibility)
    const oldStatus = call.status;
    call.status = 'accepted';
    call.token = creatorToken; // Store creator's token (for backward compatibility)
    call.tokenExpiry = tokenExpiry;
    call.acceptedAt = new Date(); // Track when call was accepted
    await call.save();

    logCallEvent('call_accepted', {
      callId,
      callerId: normalizeId(call.callerUserId),
      creatorId: normalizeId(call.creatorUserId),
      from: oldStatus,
      to: 'accepted',
      callerUid,
      creatorUid,
      tokenExpiry: tokenExpiry.toISOString(),
    });

    // Emit call_accepted event to caller via Socket.IO with caller's token
    try {
      const io = getIO();
      io.to(caller.firebaseUid || '').emit('call_accepted', {
        callId,
        channelName: call.channelName,
        token: callerToken, // Caller's token for their UID
        uid: callerUid, // Caller's UID for Agora
      });
      console.log(`📡 [SOCKET] Emitted call_accepted to caller: ${caller.firebaseUid}`);
    } catch (socketError) {
      // Don't fail the request if socket emit fails
      console.error('⚠️  [SOCKET] Failed to emit call_accepted:', socketError);
    }

    res.json({
      success: true,
      data: {
        channelName: call.channelName,
        token: creatorToken, // Creator's token for their UID
        uid: creatorUid, // Deterministic UID from userId
      },
    });
  } catch (error) {
    console.error('❌ [CALL] Accept call error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// TASK 9: End Call Handling
export const endCall = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('🔚 [CALL] End call request');
    
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    const { callId } = req.params;

    // Get user
    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    // Find call (don't populate for authorization)
    const call = await Call.findOne({ callId });
    if (!call) {
      res.status(404).json({
        success: false,
        error: 'Call not found',
      });
      return;
    }

    // 🚨 FIX: Idempotency check - prevent duplicate end calls and double deduction
    if (call.status === 'ended') {
      console.log(`⚠️  [CALL] Call ${callId} already ended, returning current state (idempotent)`);
      // Get both users for socket emission (in case they weren't notified)
      const caller = await User.findById(call.callerUserId);
      const creator = await User.findById(call.creatorUserId);
      
      // Return current state without modifying
      res.json({
        success: true,
        data: {
          callId: call.callId,
          status: 'ended',
          duration: call.duration,
          durationFormatted: call.duration ? formatDuration(call.duration) : null,
          endedAt: call.endedAt?.toISOString(),
          coinsDeducted: call.userPaidCoins || 0,
          remainingCoins: caller ? caller.coins : undefined,
          message: 'Call already ended (idempotent)',
        },
      });
      return;
    }

    // 🚨 CRITICAL: Check if call is already settled (prevent double deduction)
    if (call.isSettled) {
      console.log(`⚠️  [CALL] Call ${callId} already settled, preventing double deduction (idempotent)`);
      // Call was ended but settlement might have happened separately
      // Still allow ending the call status, but skip coin deduction
      const endedAt = new Date();
      let duration = 0;
      if (call.acceptedAt) {
        const durationMs = endedAt.getTime() - call.acceptedAt.getTime();
        duration = Math.floor(durationMs / 1000);
      }
      
      call.status = 'ended';
      call.endedAt = endedAt;
      if (!call.duration) {
        call.duration = duration;
      }
      await call.save();
      
      const caller = await User.findById(call.callerUserId);
      res.json({
        success: true,
        data: {
          callId: call.callId,
          status: 'ended',
          duration: call.duration,
          durationFormatted: call.duration ? formatDuration(call.duration) : null,
          endedAt: endedAt.toISOString(),
          coinsDeducted: call.userPaidCoins || 0,
          remainingCoins: caller ? caller.coins : undefined,
          message: 'Call already settled (idempotent)',
        },
      });
      return;
    }

    // Normalize IDs and authorize
    const userId = normalizeId(user._id);
    const isCaller = idsMatch(call.callerUserId, user._id);
    const isCreator = idsMatch(call.creatorUserId, user._id);

    if (!isCaller && !isCreator) {
      console.error('❌ [CALL] Authorization failed for endCall');
      console.error(JSON.stringify({
        authUser: userId,
        caller: getIdForLogging(call.callerUserId),
        creator: getIdForLogging(call.creatorUserId),
        isCaller,
        isCreator,
      }, null, 2));
      res.status(403).json({
        success: false,
        error: 'You are not part of this call',
      });
      return;
    }

    // Get both users for socket emission
    const caller = await User.findById(call.callerUserId);
    const creatorUser = await User.findById(call.creatorUserId);
    
    // Calculate duration if call was accepted (before updating status)
    const endedAt = new Date();
    let duration = 0;
    if (call.acceptedAt) {
      const durationMs = endedAt.getTime() - call.acceptedAt.getTime();
      duration = Math.floor(durationMs / 1000); // Duration in seconds
    }

    // Deduct coins from caller if call was accepted and has duration
    // CRITICAL: Snapshot pricing data at call time to prevent historical earnings changes
    let coinsDeducted = 0;
    const CREATOR_SHARE_PERCENTAGE = 0.30; // Creator earns 30% of what user pays (snapshot this too)
    
    if (call.status === 'accepted' && duration > 0 && caller) {
      try {
        // Get creator profile to get price per minute
        const creatorProfile = await Creator.findOne({ userId: call.creatorUserId });
        if (creatorProfile && creatorProfile.price > 0) {
          // Calculate duration in minutes (including partial minutes)
          // e.g., 30 seconds = 0.5 minutes, 90 seconds = 1.5 minutes
          const durationMinutes = duration / 60;
          
          // Calculate coins to deduct: price per minute * duration in minutes
          // 🚨 CRITICAL: Use Math.ceil (industry standard - "any started fraction is charged")
          // Math.round creates billing anomalies (0.1 min = free, 0.6 min = overcharge)
          // Math.ceil ensures: 0.1 min = 1 coin, 0.6 min = 1 coin, 1.49 min = 2 coins
          // e.g., 20 coins/min * 0.1 min = 1 coin (not 0), 20 coins/min * 1.49 min = 30 coins
          coinsDeducted = Math.ceil(creatorProfile.price * durationMinutes);
          
          // Ensure we don't deduct more than user has
          const currentCoins = caller.coins || 0;
          if (coinsDeducted > currentCoins) {
            // Deduct only what user has
            // 🚨 NOTE: In production, you should auto-end calls when coins hit 0
            // This is a safety measure - ideally the call should have been ended when balance reached 0
            coinsDeducted = currentCoins;
            console.log(`⚠️  [CALL] User has insufficient coins. Deducting all available: ${coinsDeducted}`);
            console.log(`   ⚠️  FUTURE: Implement auto-end call when coins hit 0 during active call`);
          }
          
          // Deduct coins from caller
          caller.coins = Math.max(0, currentCoins - coinsDeducted);
          await caller.save();

          // Phase C1: Emit coins_updated after coins mutation is persisted
          // Payload is minimal & sufficient: { userId, coins }
          try {
            const io = getIO();
            if (caller.firebaseUid) {
              io.to(caller.firebaseUid).emit('coins_updated', {
                userId: caller._id.toString(),
                coins: caller.coins,
              });
              console.log(`📡 [SOCKET] Emitted coins_updated to caller: ${caller.firebaseUid}`);
            }
          } catch (socketError) {
            // Don't fail the request if socket emit fails
            console.error('⚠️  [SOCKET] Failed to emit coins_updated:', socketError);
          }
          
          // 🔒 SNAPSHOT: Pricing data should already be set at acceptCall
          // If missing (legacy calls), use current price as fallback
          if (!call.priceAtCallTime) {
            console.log(`⚠️  [CALL] Missing price snapshot, using current price as fallback`);
            call.priceAtCallTime = creatorProfile.price;
            call.creatorShareAtCallTime = CREATOR_SHARE_PERCENTAGE;
          }
          call.userPaidCoins = coinsDeducted;
          
          // 🚨 CRITICAL: Mark as settled to prevent double deduction (idempotency)
          call.isSettled = true;
          
          // 📝 Create transaction record for user (debit)
          try {
            const transaction = new CoinTransaction({
              transactionId: `call_${call.callId}_${Date.now()}`,
              userId: caller._id,
              type: 'debit',
              coins: coinsDeducted,
              source: 'video_call',
              description: `Video call with creator (${durationMinutes.toFixed(2)} min)`,
              callId: call.callId,
              status: 'completed',
            });
            await transaction.save();
            console.log(`📝 [CALL] Transaction record created for coin deduction`);
          } catch (txError) {
            console.error('⚠️  [CALL] Failed to create transaction record:', txError);
            // Don't fail the call end if transaction record fails
          }
          
          console.log(`💰 [CALL] Coins deducted from caller:`);
          console.log(`   Creator price (snapshot): ${creatorProfile.price} coins/min`);
          console.log(`   Creator share (snapshot): ${(CREATOR_SHARE_PERCENTAGE * 100).toFixed(0)}%`);
          console.log(`   Duration: ${duration} seconds (${durationMinutes.toFixed(2)} minutes)`);
          console.log(`   Coins deducted (snapshot): ${coinsDeducted}`);
          console.log(`   Caller balance: ${currentCoins} → ${caller.coins}`);
        } else {
          console.log(`⚠️  [CALL] Creator profile not found or price not set, skipping coin deduction`);
        }
      } catch (coinError) {
        console.error('❌ [CALL] Error deducting coins:', coinError);
        // Don't fail the call end if coin deduction fails - log and continue
      }
    }
    
    const oldStatus = call.status;
    
    // 🔥 FIX #2: Emit socket event BEFORE DB write for instant UX
    // Socket is real-time, DB is bookkeeping. If DB write fails, we can retry.
    // If UX lags, users think the app is broken.
    // 🔒 TERMINAL EVENT: This event means the call will never be ringing again. Ever.
    const eventData = {
      callId,
      status: 'ended',
      endedBy: isCaller ? 'caller' : 'creator',
      reason: isCaller ? 'user_hung_up' : 'creator_hung_up',
      duration: duration,
      durationFormatted: duration > 0 ? formatDuration(duration) : null,
      endedAt: endedAt.toISOString(),
    };
    
    try {
      const io = getIO();
      
      if (caller?.firebaseUid) {
        io.to(caller.firebaseUid).emit('call_ended', eventData);
        console.log(`📡 [SOCKET] Emitted call_ended to caller: ${caller.firebaseUid} (BEFORE DB write)`);
      }
      
      if (creatorUser?.firebaseUid) {
        io.to(creatorUser.firebaseUid).emit('call_ended', eventData);
        console.log(`📡 [SOCKET] Emitted call_ended to creator: ${creatorUser.firebaseUid} (BEFORE DB write)`);
      }
    } catch (socketError) {
      console.error('⚠️  [SOCKET] Failed to emit call_ended:', socketError);
      // Continue with DB write even if socket emit fails
    }
    
    // Update call status and calculate duration (AFTER emitting socket event)
    call.status = 'ended';
    call.endedAt = endedAt;
    call.duration = duration;
    
    await call.save();

    logCallEvent('call_ended', {
      callId,
      callerId: normalizeId(call.callerUserId),
      creatorId: normalizeId(call.creatorUserId),
      from: oldStatus,
      to: 'ended',
      endedBy: isCaller ? 'caller' : 'creator',
      duration: duration,
      durationSeconds: duration,
    });

    res.json({
      success: true,
      data: {
        callId,
        status: 'ended',
        duration: call.duration, // Duration in seconds
        durationFormatted: call.duration ? formatDuration(call.duration) : null,
        endedAt: endedAt.toISOString(),
        coinsDeducted: coinsDeducted > 0 ? coinsDeducted : undefined, // Only include if coins were deducted
        remainingCoins: caller ? caller.coins : undefined, // Return updated coin balance
      },
    });
  } catch (error) {
    console.error('❌ [CALL] End call error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// TASK 10: Reject Call
export const rejectCall = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('❌ [CALL] Reject call request');
    
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    const { callId } = req.params;

    // Get creator
    const creator = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!creator) {
      res.status(404).json({
        success: false,
        error: 'Creator not found',
      });
      return;
    }

    // Find call (don't populate for authorization)
    const call = await Call.findOne({ callId });
    if (!call) {
      res.status(404).json({
        success: false,
        error: 'Call not found',
      });
      return;
    }

    // Normalize IDs and validate creator owns this call
    if (!idsMatch(call.creatorUserId, creator._id)) {
      console.error('❌ [CALL] Authorization failed for rejectCall');
      console.error(JSON.stringify({
        authCreator: getIdForLogging(creator._id),
        callCreator: getIdForLogging(call.creatorUserId),
      }, null, 2));
      res.status(403).json({
        success: false,
        error: 'You do not have permission to reject this call',
      });
      return;
    }

    // 🚨 FIX: Idempotency check - prevent rejecting already rejected/ended calls
    if (call.status === 'rejected' || call.status === 'ended') {
      console.log(`⚠️  [CALL] Call ${callId} already ${call.status}, returning current state`);
      // Get caller for socket emission (in case they weren't notified)
      const caller = await User.findById(call.callerUserId);
      
      // Return current state without modifying
      res.json({
        success: true,
        data: {
          callId: call.callId,
          status: call.status,
        },
      });
      return;
    }

    // Check if call is in a valid state to be rejected (must be ringing)
    if (call.status !== 'ringing') {
      res.status(400).json({
        success: false,
        error: `Cannot reject call with status: ${call.status}. Call must be ringing.`,
      });
      return;
    }

    // Get caller to get their firebaseUid for socket emission
    const caller = await User.findById(call.callerUserId);
    if (!caller) {
      res.status(404).json({
        success: false,
        error: 'Caller not found',
      });
      return;
    }

    // Update call status
    const oldStatus = call.status;
    call.status = 'rejected';
    await call.save();

    logCallEvent('call_rejected', {
      callId,
      callerId: normalizeId(call.callerUserId),
      creatorId: normalizeId(call.creatorUserId),
      from: oldStatus,
      to: 'rejected',
    });

    // Emit call_rejected event to caller via Socket.IO
    try {
      const io = getIO();
      io.to(caller.firebaseUid || '').emit('call_rejected', {
        callId,
        status: 'rejected',
      });
      console.log(`📡 [SOCKET] Emitted call_rejected to caller: ${caller.firebaseUid}`);
    } catch (socketError) {
      console.error('⚠️  [SOCKET] Failed to emit call_rejected:', socketError);
    }

    res.json({
      success: true,
      data: {
        callId,
        status: 'rejected',
      },
    });
  } catch (error) {
    console.error('❌ [CALL] Reject call error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// Get call status (for polling)
export const getCallStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    const { callId } = req.params;

    // Find call WITHOUT populate for authorization
    const call = await Call.findOne({ callId });
    
    if (!call) {
      res.status(404).json({
        success: false,
        error: 'Call not found',
      });
      return;
    }

    // Get user to verify they're part of the call
    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    // Normalize IDs BEFORE authorization (don't rely on populate)
    const callerId = normalizeId(call.callerUserId);
    const creatorId = normalizeId(call.creatorUserId);
    const userId = normalizeId(user._id);
    
    // Authorize using normalized IDs
    const isCaller = idsMatch(call.callerUserId, user._id);
    const isCreator = idsMatch(call.creatorUserId, user._id);

    if (!isCaller && !isCreator) {
      console.error('❌ [CALL] Authorization failed for getCallStatus');
      console.error(JSON.stringify({
        authUser: userId,
        caller: callerId,
        creator: creatorId,
        isCaller,
        isCreator,
      }, null, 2));
      res.status(403).json({
        success: false,
        error: 'You are not part of this call',
      });
      return;
    }

    // NOW populate for response shaping (after authorization passes)
    await call.populate('callerUserId', 'username avatar');
    await call.populate('creatorUserId', 'username avatar');

    // Generate UIDs using normalized IDs
    const callerUid = generateUidFromUserId(callerId);
    const creatorUid = generateUidFromUserId(creatorId);
    
    // Determine which UID to return based on who's requesting
    const userUid = isCaller ? callerUid : creatorUid;

    // 🚨 FIX: Generate token for the requesting user's UID (tokens are UID-specific)
    // The stored token is for the creator, but caller needs their own token
    let token: string | undefined;
    if (call.status === 'accepted') {
      token = generateAgoraToken(call.channelName, userUid);
    }

    res.json({
      success: true,
      data: {
        callId: call.callId,
        channelName: call.channelName,
        // Include participant IDs for client-side logic (e.g., rating prompt gating)
        callerUserId: normalizeId(call.callerUserId),
        creatorUserId: normalizeId(call.creatorUserId),
        status: call.status,
        token,
        uid: call.status === 'accepted' ? userUid : undefined,
        // Rating is only relevant/visible for the caller (end-user) to rate the creator
        rating: isCaller ? (call.rating ?? null) : undefined,
        ratedAt: isCaller && call.ratedAt ? call.ratedAt.toISOString() : undefined,
        caller: {
          id: normalizeId(call.callerUserId),
          username: (call.callerUserId as any).username,
          avatar: (call.callerUserId as any).avatar,
        },
        creator: {
          id: normalizeId(call.creatorUserId),
          username: (call.creatorUserId as any).username,
          avatar: (call.creatorUserId as any).avatar,
        },
      },
    });
  } catch (error) {
    console.error('❌ [CALL] Get call status error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// Get incoming calls for creator
export const getIncomingCalls = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    // Get creator
    const creator = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!creator) {
      res.status(404).json({
        success: false,
        error: 'Creator not found',
      });
      return;
    }

    // Get active incoming calls (ringing)
    const calls = await Call.find({
      creatorUserId: creator._id,
      status: 'ringing',
    })
      .populate('callerUserId', 'username avatar')
      .sort({ createdAt: -1 })
      .limit(10);

    res.json({
      success: true,
      data: {
        calls: calls.map((call) => ({
          callId: call.callId,
          channelName: call.channelName,
          status: call.status,
          caller: {
            id: (call.callerUserId as any)._id.toString(),
            username: (call.callerUserId as any).username,
            avatar: (call.callerUserId as any).avatar,
          },
          createdAt: call.createdAt,
        })),
      },
    });
  } catch (error) {
    console.error('❌ [CALL] Get incoming calls error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// Get recent calls for the authenticated user (both users & creators)
export const getRecentCalls = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const calls = await Call.find({
      $or: [{ callerUserId: user._id }, { creatorUserId: user._id }],
      status: { $in: ['ended', 'missed', 'rejected'] as CallStatus[] },
    })
      .populate('callerUserId', 'username avatar')
      .populate('creatorUserId', 'username avatar')
      .sort({ endedAt: -1, updatedAt: -1, createdAt: -1 })
      .limit(50);

    // Fetch creator profiles for all creator user IDs to get creator names and photos
    // Extract unique creator user IDs (as ObjectIds) from calls
    const creatorUserIds = [...new Set(calls.map(call => {
      const creatorId = call.creatorUserId as any;
      return creatorId._id ? creatorId._id : creatorId;
    }))];
    const creators = await Creator.find({ userId: { $in: creatorUserIds } });
    const creatorMap = new Map<string, { name: string; photo: string }>();
    creators.forEach(creator => {
      const userId = normalizeId(creator.userId);
      creatorMap.set(userId, { name: creator.name, photo: creator.photo });
    });

    res.json({
      success: true,
      data: {
        calls: calls.map((call) => {
          const isCaller = idsMatch(call.callerUserId, user._id);
          const durationFormatted = call.duration != null ? formatDuration(call.duration) : null;

          // Get creator info - prefer Creator model data (name/photo) over User model data (username/avatar)
          const creatorUserId = normalizeId(call.creatorUserId);
          const creatorProfile = creatorMap.get(creatorUserId);
          const creatorUsername = creatorProfile?.name ?? (call.creatorUserId as any).username;
          const creatorAvatar = creatorProfile?.photo ?? (call.creatorUserId as any).avatar;

          return {
            callId: call.callId,
            channelName: call.channelName,
            callerUserId: normalizeId(call.callerUserId),
            creatorUserId: creatorUserId,
            status: call.status,
            createdAt: call.createdAt?.toISOString(),
            updatedAt: call.updatedAt?.toISOString(),
            acceptedAt: call.acceptedAt ? call.acceptedAt.toISOString() : undefined,
            endedAt: call.endedAt ? call.endedAt.toISOString() : undefined,
            duration: call.duration ?? undefined,
            durationFormatted,
            // Rating only for caller (end-user visibility)
            rating: isCaller ? (call.rating ?? null) : undefined,
            ratedAt: isCaller && call.ratedAt ? call.ratedAt.toISOString() : undefined,
            caller: {
              id: normalizeId(call.callerUserId),
              username: (call.callerUserId as any).username,
              avatar: (call.callerUserId as any).avatar,
            },
            creator: {
              id: creatorUserId,
              username: creatorUsername,
              avatar: creatorAvatar,
            },
          };
        }),
      },
    });
  } catch (error) {
    console.error('❌ [CALL] Get recent calls error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// Rate a call (caller only) - rating is stored per call
export const rateCall = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { callId } = req.params;
    const { rating } = req.body as { rating?: unknown };

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    // Only end-users can rate
    if (user.role === 'creator' || user.role === 'admin') {
      res.status(403).json({ success: false, error: 'Only end users can rate creators' });
      return;
    }

    const parsedRating = typeof rating === 'number' ? rating : (typeof rating === 'string' ? Number(rating) : NaN);
    if (!Number.isFinite(parsedRating) || parsedRating < 1 || parsedRating > 5) {
      res.status(400).json({ success: false, error: 'rating must be a number between 1 and 5' });
      return;
    }

    const call = await Call.findOne({ callId });
    if (!call) {
      res.status(404).json({ success: false, error: 'Call not found' });
      return;
    }

    // Caller-only authorization
    if (!idsMatch(call.callerUserId, user._id)) {
      res.status(403).json({ success: false, error: 'You are not the caller for this call' });
      return;
    }

    // Must be ended to rate (per requirements: after call ended)
    if (call.status !== 'ended') {
      res.status(400).json({ success: false, error: 'Call must be ended before rating' });
      return;
    }

    // Idempotency: only allow rating once per call
    if (call.ratedByCaller || call.rating != null) {
      res.status(409).json({
        success: false,
        error: 'Call already rated',
        data: {
          callId: call.callId,
          rating: call.rating,
          ratedAt: call.ratedAt?.toISOString(),
        },
      });
      return;
    }

    call.rating = Math.round(parsedRating);
    call.ratedAt = new Date();
    call.ratedByCaller = true;
    await call.save();

    res.json({
      success: true,
      data: {
        callId: call.callId,
        rating: call.rating,
        ratedAt: call.ratedAt.toISOString(),
      },
    });
  } catch (error) {
    console.error('❌ [CALL] Rate call error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
