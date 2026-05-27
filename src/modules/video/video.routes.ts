import { Router, Request, Response } from 'express';
import { getVideoToken } from './video.controller';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import { verifyStreamWebhookSignature } from '../../middlewares/webhook-signature.middleware';
import { webhookLimiter } from '../../middlewares/rate-limit.middleware';
import { handleStreamVideoWebhook } from './video.webhook';
import { User } from '../user/user.model';
import {
  isRedisConfigured,
  getRedis,
} from '../../config/redis';
import { isCallActive } from '../billing/billing-active-call.service';
import { resolveActiveRuntimeStateForUser } from '../billing/billing-runtime-resolver.service';

const router = Router();

router.post('/token', verifyFirebaseToken, getVideoToken);

/**
 * Active billable call for this user (same source as Socket.IO `billing:recover-state`).
 */
router.get('/calls/active', verifyFirebaseToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const firebaseUid = req.auth?.firebaseUid;
    if (!firebaseUid) {
      res.status(401).json({ success: false, error: 'Not authenticated' });
      return;
    }

    const user = await User.findOne({ firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    if (!isRedisConfigured()) {
      res.json({
        success: true,
        data: { activeCalls: [] as { callId: string }[] },
      });
      return;
    }

    const redis = getRedis();
    const activeRuntime = await resolveActiveRuntimeStateForUser(firebaseUid);
    const callId = activeRuntime.callId;
    if (!callId || !activeRuntime.runtime.session) {
      res.json({
        success: true,
        data: { activeCalls: [] as { callId: string }[] },
      });
      return;
    }

    const active = await isCallActive(redis, {
      callId,
      userFirebaseUid: firebaseUid,
    });
    if (!active) {
      res.json({
        success: true,
        data: { activeCalls: [] as { callId: string }[] },
      });
      return;
    }

    res.json({
      success: true,
      data: {
        activeCalls: [{ callId }],
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    console.error('❌ [VIDEO] Error getting active calls:', error);
    res.status(500).json({ success: false, error: message });
  }
});

router.post('/webhook', webhookLimiter, verifyStreamWebhookSignature, handleStreamVideoWebhook);

export default router;
