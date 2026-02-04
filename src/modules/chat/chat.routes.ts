import { Router } from 'express';
import { getChatToken, createOrGetChannel } from './chat.controller';
import { handleStreamWebhook } from './chat.webhook';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';

const router = Router();

// Get Stream Chat token
router.post('/token', verifyFirebaseToken, getChatToken);

// Create or get channel
router.post('/channel', verifyFirebaseToken, createOrGetChannel);

// Stream webhook endpoint (no auth required - Stream will call this directly)
// Note: In production, you should verify webhook signature or use IP whitelist
router.post('/webhook', handleStreamWebhook);

export default router;
