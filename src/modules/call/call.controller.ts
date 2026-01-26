import type { Request } from 'express';
import { Response } from 'express';
import { Call, CallStatus } from './call.model';
import { User } from '../user/user.model';
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

    // 🚨 FIX: Idempotency check - prevent duplicate end calls
    if (call.status === 'ended') {
      console.log(`⚠️  [CALL] Call ${callId} already ended, returning current state`);
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
    const creator = await User.findById(call.creatorUserId);
    
    // Update call status and calculate duration
    const oldStatus = call.status;
    const endedAt = new Date();
    call.status = 'ended';
    call.endedAt = endedAt;
    
    // Calculate duration if call was accepted
    if (call.acceptedAt) {
      const durationMs = endedAt.getTime() - call.acceptedAt.getTime();
      call.duration = Math.floor(durationMs / 1000); // Duration in seconds
    }
    
    await call.save();

    logCallEvent('call_ended', {
      callId,
      callerId: normalizeId(call.callerUserId),
      creatorId: normalizeId(call.creatorUserId),
      from: oldStatus,
      to: 'ended',
      endedBy: isCaller ? 'caller' : 'creator',
      duration: call.duration,
      durationSeconds: call.duration,
    });

    // Emit call_ended event to both parties via Socket.IO
    try {
      const io = getIO();
      const eventData = {
        callId,
        status: 'ended',
        endedBy: isCaller ? 'caller' : 'creator',
        duration: call.duration,
        durationFormatted: call.duration ? formatDuration(call.duration) : null,
        endedAt: endedAt.toISOString(),
      };
      
      if (caller?.firebaseUid) {
        io.to(caller.firebaseUid).emit('call_ended', eventData);
        console.log(`📡 [SOCKET] Emitted call_ended to caller: ${caller.firebaseUid}`);
      }
      
      if (creator?.firebaseUid) {
        io.to(creator.firebaseUid).emit('call_ended', eventData);
        console.log(`📡 [SOCKET] Emitted call_ended to creator: ${creator.firebaseUid}`);
      }
    } catch (socketError) {
      console.error('⚠️  [SOCKET] Failed to emit call_ended:', socketError);
    }

    res.json({
      success: true,
      data: {
        callId,
        status: 'ended',
        duration: call.duration, // Duration in seconds
        durationFormatted: call.duration ? formatDuration(call.duration) : null,
        endedAt: endedAt.toISOString(),
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
        status: call.status,
        token,
        uid: call.status === 'accepted' ? userUid : undefined,
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
