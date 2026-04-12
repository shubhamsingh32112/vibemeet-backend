import type { Request } from 'express';
import { Response } from 'express';
import { User } from '../user/user.model';
import { generateStreamVideoToken } from '../../config/stream-video';
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

    const user = await User.findOne({ firebaseUid });
    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    let streamRole: 'user' | 'call_member';

    if (requestedRole) {
      if (requestedRole === 'creator' && user.role !== 'creator') {
        res.status(403).json({
          success: false,
          error: 'User is not a creator',
        });
        return;
      }
      streamRole = requestedRole === 'creator' ? 'call_member' : 'user';
    } else {
      streamRole = user.role === 'creator' ? 'call_member' : 'user';
    }

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
