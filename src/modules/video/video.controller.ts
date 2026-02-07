import type { Request } from 'express';
import { Response } from 'express';
import axios from 'axios';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { Call } from './call.model';
import { generateStreamVideoToken, generateCallId, generateServerSideToken } from '../../config/stream-video';

/**
 * POST /api/v1/video/token
 * Generate Stream Video JWT token for authenticated user
 * 
 * Input:
 * {
 *   "role": "user" | "creator"  // Optional, defaults to user's role from DB
 * }
 * 
 * Output:
 * {
 *   "success": true,
 *   "data": {
 *     "token": "STREAM_VIDEO_JWT"
 *   }
 * }
 */
export const getVideoToken = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    const firebaseUid = req.auth.firebaseUid;
    const requestedRole = req.body.role as 'user' | 'creator' | undefined;

    // Get user from database
    const user = await User.findOne({ firebaseUid });
    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    // Determine Stream Video role
    // - Regular users get 'user' role
    // - Creators get 'call_member' role (allows them to join calls as members)
    let streamRole: 'user' | 'call_member';
    
    if (requestedRole) {
      // If role is explicitly requested, validate it matches user's actual role
      if (requestedRole === 'creator' && user.role !== 'creator') {
        res.status(403).json({
          success: false,
          error: 'User is not a creator',
        });
        return;
      }
      streamRole = requestedRole === 'creator' ? 'call_member' : 'user';
    } else {
      // Auto-detect based on user's role
      streamRole = user.role === 'creator' ? 'call_member' : 'user';
    }

    // Generate token
    const token = generateStreamVideoToken(firebaseUid, streamRole);

    console.log(`✅ [VIDEO] Token generated for ${firebaseUid} with role: ${streamRole}`);

    res.json({
      success: true,
      data: {
        token,
      },
    });
  } catch (error) {
    console.error('❌ [VIDEO] Error generating token:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate video token',
    });
  }
};

/**
 * POST /api/v1/video/call/initiate
 * Create or get existing call between user and creator
 * 
 * Rules:
 * - Only users (not creators) can initiate calls
 * - Exactly 2 participants: user (admin) + creator (call_member)
 * - Deterministic call ID: userId_creatorId
 * - If call exists, reuse it
 * 
 * Input:
 * {
 *   "creatorId": "CREATOR_MONGODB_OBJECT_ID"
 * }
 * 
 * Output:
 * {
 *   "success": true,
 *   "data": {
 *     "callId": "userId_creatorId",
 *     "callType": "default"
 *   }
 * }
 */
export const initiateCall = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    const firebaseUid = req.auth.firebaseUid;
    const { creatorId } = req.body;

    // Validate input
    if (!creatorId) {
      res.status(400).json({
        success: false,
        error: 'creatorId is required',
      });
      return;
    }

    // Get current user
    const user = await User.findOne({ firebaseUid });
    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    // CRITICAL: Only users (not creators) can initiate calls
    // 🔥 Creators don't need coins to receive calls - they can receive calls for free
    if (user.role !== 'user') {
      res.status(403).json({
        success: false,
        error: 'Only users can initiate calls. Creators cannot call other creators.',
      });
      return;
    }

    // PHASE 8: Standardized error code - User must have ≥ 10 coins to start a call
    // 🔥 Only applies to users (not creators) - creators receive calls for free
    if (user.coins < 10) {
      res.status(403).json({
        success: false,
        error: 'INSUFFICIENT_COINS_MIN_10',
        message: 'Minimum 10 coins required to start a call',
        coinsRequired: 10,
        coinsAvailable: user.coins,
      });
      return;
    }

    // Validate creator exists and is actually a creator
    const creator = await Creator.findById(creatorId);
    if (!creator) {
      res.status(404).json({
        success: false,
        error: 'Creator not found',
      });
      return;
    }

    // Get creator's user document to get Firebase UID
    const creatorUser = await User.findById(creator.userId);
    if (!creatorUser) {
      res.status(404).json({
        success: false,
        error: 'Creator user not found',
      });
      return;
    }

    // Validate creator is actually a creator
    if (creatorUser.role !== 'creator') {
      res.status(400).json({
        success: false,
        error: 'Target user is not a creator',
      });
      return;
    }

    // Check if creator is already in a call
    if (creator.currentCallId) {
      res.status(409).json({
        success: false,
        error: 'Creator is already in a call',
      });
      return;
    }

    // Generate deterministic call ID
    const callId = generateCallId(firebaseUid, creatorId.toString());
    const callType = 'default';

    // Generate server-side JWT token for Stream Video API calls
    const serverToken = generateServerSideToken();

    // Get API key for query parameter (required by Stream Video API)
    const apiKey = process.env.STREAM_API_KEY;
    if (!apiKey) {
      res.status(500).json({
        success: false,
        error: 'Stream Video service not configured',
        details: 'STREAM_API_KEY must be set',
      });
      return;
    }

    // Stream Video API endpoint for creating calls
    // CORRECT FORMAT: /v1/calls/{callType}?id={callId} (callId is query param, NOT in path)
    // API key MUST be in query parameter (not URL-encoded, not in headers)
    const streamApiUrl = `https://video.stream-io-api.com/v1/calls/${callType}?id=${callId}&api_key=${apiKey}`;

    // Prepare call members
    // - User gets 'admin' role (can manage call)
    // - Creator gets 'call_member' role (can join but not manage)
    const members = [
      {
        user_id: firebaseUid,
        role: 'admin', // User is admin (caller)
      },
      {
        user_id: creatorUser.firebaseUid,
        role: 'call_member', // Creator is member (callee)
      },
    ];

    // Call settings
    const callSettings = {
      ring: true, // Enable ringing
      video: true, // Video call
      max_participants: 2, // Hard limit: exactly 2 participants
    };

    console.log(`🔄 [VIDEO] Creating/getting call: ${callId}`);
    console.log(`   User: ${firebaseUid} (admin)`);
    console.log(`   Creator: ${creatorUser.firebaseUid} (call_member)`);

    try {
      // POST with ?create=true is idempotent - returns existing call if it exists, creates new one if not
      // API key is already in URL query parameter
      console.log(`🔄 [VIDEO] Calling Stream API: ${streamApiUrl}`);
      console.log(`   Members: ${JSON.stringify(members)}`);
      console.log(`   Settings: ${JSON.stringify(callSettings)}`);

      const response = await axios.post(
        streamApiUrl,
        {
          members,
          settings_override: callSettings,
        },
        {
          headers: {
            Authorization: `Bearer ${serverToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      console.log('✅ [VIDEO] Call ready:', JSON.stringify(response.data, null, 2));

      // Create or update call record in database
      const callRecord = await Call.findOneAndUpdate(
        { callId },
        {
          callId,
          callerUserId: user._id,
          creatorUserId: creatorUser._id,
          status: 'ringing',
        },
        { upsert: true, new: true }
      );

      console.log(`✅ [VIDEO] Call record created/updated: ${callRecord._id}`);

      res.json({
        success: true,
        data: {
          callId,
          callType,
        },
      });
    } catch (error: any) {
      const errorDetails = error.response?.data || error.message;
      const statusCode = error.response?.status || 500;
      
      // Enhanced error logging to help debug Stream API issues
      console.error('❌ [VIDEO] Error creating/getting call:');
      console.error(`   Status: ${statusCode}`);
      console.error(`   URL: ${streamApiUrl}`);
      console.error(`   Request body: ${JSON.stringify({ members, settings_override: callSettings }, null, 2)}`);
      console.error(`   Response: ${JSON.stringify(errorDetails, null, 2)}`);
      console.error(`   Message: ${error.message}`);
      if (error.response?.headers) {
        console.error(`   Response headers: ${JSON.stringify(error.response.headers, null, 2)}`);
      }
      
      // Return the actual Stream error details to help debug
      res.status(500).json({
        success: false,
        error: 'Failed to create call',
        details: error.response?.data?.error?.message || error.response?.data?.message || error.message,
        streamError: error.response?.data,
        statusCode: statusCode,
      });
    }
  } catch (error: any) {
    console.error('❌ [VIDEO] Unexpected error initiating call:');
    console.error(`   Error type: ${error?.constructor?.name || 'Unknown'}`);
    console.error(`   Message: ${error?.message || 'No message'}`);
    if (error?.stack) {
      console.error(`   Stack: ${error.stack}`);
    }
    if (error?.response) {
      console.error(`   Response status: ${error.response.status}`);
      console.error(`   Response data: ${JSON.stringify(error.response.data, null, 2)}`);
    }
    
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error?.message || 'An unexpected error occurred',
    });
  }
};

/**
 * POST /api/v1/video/call/accept
 * Accept a call (creator side)
 * 
 * This locks the creator's availability and snapshots pricing data.
 * 
 * Input:
 * {
 *   "callId": "call_id_string"
 * }
 */
export const acceptCall = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    const firebaseUid = req.auth.firebaseUid;
    const { callId } = req.body;

    if (!callId) {
      res.status(400).json({
        success: false,
        error: 'callId is required',
      });
      return;
    }

    // Get current user (should be creator)
    const user = await User.findOne({ firebaseUid });
    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    // Find call record
    const call = await Call.findOne({ callId });
    if (!call) {
      res.status(404).json({
        success: false,
        error: 'Call not found',
      });
      return;
    }

    // Verify user is the creator for this call
    if (call.creatorUserId.toString() !== user._id.toString()) {
      res.status(403).json({
        success: false,
        error: 'Only the creator can accept this call',
      });
      return;
    }

    // Check call status
    if (call.status !== 'ringing') {
      res.status(400).json({
        success: false,
        error: `Call is not in ringing state. Current status: ${call.status}`,
      });
      return;
    }

    // Get creator profile
    const creator = await Creator.findOne({ userId: user._id });
    if (!creator) {
      res.status(404).json({
        success: false,
        error: 'Creator profile not found',
      });
      return;
    }

    // Check if creator is already in a call
    if (creator.currentCallId && creator.currentCallId !== callId) {
      res.status(409).json({
        success: false,
        error: 'Creator is already in another call',
      });
      return;
    }

    // Get caller to check coins
    const caller = await User.findById(call.callerUserId);
    if (!caller) {
      res.status(404).json({
        success: false,
        error: 'Caller not found',
      });
      return;
    }

    // SNAPSHOT: Store pricing data at call time
    call.priceAtCallTime = creator.price;
    call.creatorShareAtCallTime = 0.30; // 30% default (configurable)
    call.acceptedAt = new Date();
    call.status = 'accepted';

    // LOCK: Set creator availability
    creator.isOnline = false; // Creator is busy
    creator.currentCallId = callId; // Lock creator to this call

    await call.save();
    await creator.save();

    console.log(`✅ [VIDEO] Call ${callId} accepted by creator ${user._id}`);
    console.log(`   Price snapshot: ${call.priceAtCallTime} coins/min`);
    console.log(`   Creator share: ${call.creatorShareAtCallTime * 100}%`);

    res.json({
      success: true,
      data: {
        callId,
        priceAtCallTime: call.priceAtCallTime,
        creatorShareAtCallTime: call.creatorShareAtCallTime,
      },
    });
  } catch (error: any) {
    console.error('❌ [VIDEO] Error accepting call:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error?.message || 'An unexpected error occurred',
    });
  }
};
