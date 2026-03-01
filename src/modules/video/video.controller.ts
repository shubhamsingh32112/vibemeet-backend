import type { Request } from 'express';
import { Response } from 'express';
import { User } from '../user/user.model';
import { generateStreamVideoToken } from '../../config/stream-video';
import { videoCallService, VideoCallError } from './video.service';
import { logDebug } from '../../utils/logger';

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

    logDebug('Video token generated', { firebaseUid, streamRole });

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

    try {
      const result = await videoCallService.initiateCallForUser(
        firebaseUid,
        creatorId
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      if (err instanceof VideoCallError) {
        res.status(err.status).json({
          success: false,
          error: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        });
        return;
      }

      console.error('❌ [VIDEO] Unexpected error initiating call (controller):', err);
      res.status(500).json({
        success: false,
        error: 'INTERNAL_ERROR',
        message: err?.message || 'An unexpected error occurred',
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

    try {
      const result = await videoCallService.acceptCallForCreator(
        firebaseUid,
        callId
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      if (err instanceof VideoCallError) {
        res.status(err.status).json({
          success: false,
          error: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        });
        return;
      }

      console.error('❌ [VIDEO] Unexpected error accepting call (controller):', err);
      res.status(500).json({
        success: false,
        error: 'INTERNAL_ERROR',
        message: err?.message || 'An unexpected error occurred',
      });
    }
  } catch (error: any) {
    console.error('❌ [VIDEO] Error accepting call:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error?.message || 'An unexpected error occurred',
    });
  }
};
