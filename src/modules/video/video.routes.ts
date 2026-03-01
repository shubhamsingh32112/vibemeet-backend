import { Router, Request, Response } from 'express';
import { getVideoToken, initiateCall, acceptCall } from './video.controller';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import { verifyStreamWebhookSignature } from '../../middlewares/webhook-signature.middleware';
import { callInitiateLimiter, callAcceptLimiter, webhookLimiter } from '../../middlewares/rate-limit.middleware';
import { handleStreamVideoWebhook } from './video.webhook';
import { User } from '../user/user.model';
import { getRedis, callSessionKey } from '../../config/redis';

const router = Router();

// Get Stream Video token
// Backend only handles authentication and token generation
// Call creation is done via Flutter SDK (getOrCreate) - not via REST
router.post('/token', verifyFirebaseToken, getVideoToken);

// Initiate call (creates call record in DB)
// 🔥 FIX 11: Rate limiting - 10 calls per minute per user
router.post('/call/initiate', verifyFirebaseToken, callInitiateLimiter, initiateCall);


// Accept call (creator side - locks availability and snapshots price)
// 🔥 FIX 11: Rate limiting - 20 accepts per minute per user
router.post('/call/accept', verifyFirebaseToken, callAcceptLimiter, acceptCall);

// 🔥 FIX 16: Get active calls for user (for Socket.IO state recovery)
router.get('/calls/active', verifyFirebaseToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const firebaseUid = req.auth?.firebaseUid;
    if (!firebaseUid) {
      res.status(401).json({ success: false, error: 'Not authenticated' });
      return;
    }

    const redis = getRedis();
    
    // Get user from database
    const user = await User.findOne({ firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    // Note: Active calls are tracked in billing.gateway.ts via activeCallsByUser map
    // For state recovery, the frontend should use Socket.IO 'billing:recover-state' event
    // This endpoint is provided for REST-based recovery if needed
    
    res.json({
      success: true,
      data: {
        activeCalls: [],
        message: 'Use Socket.IO billing:recover-state event for state recovery',
      },
    });
  } catch (error: any) {
    console.error('❌ [VIDEO] Error getting active calls:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
});

// Stream Video webhook endpoint with signature verification
// 🔒 SECURITY: Webhook signature is verified before processing
// 🔥 FIX 11: Rate limiting - 100 webhooks per minute per IP
router.post('/webhook', webhookLimiter, verifyStreamWebhookSignature, handleStreamVideoWebhook);

export default router;
