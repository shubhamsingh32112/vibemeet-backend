import { Router } from 'express';
import {
  getChatToken,
  createOrGetChannel,
  preSendMessage,
  getMessageQuota,
} from './chat.controller';
import { handleStreamWebhook } from './chat.webhook';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';

const router = Router();

// Get Stream Chat token
router.post('/token', verifyFirebaseToken, getChatToken);

// Create or get channel (returns quota info)
router.post('/channel', verifyFirebaseToken, createOrGetChannel);

// Pre-send check — frontend calls this BEFORE every user message
// Validates quota, deducts coins if needed
router.post('/pre-send', verifyFirebaseToken, preSendMessage);

// Get message quota for a channel (free remaining, cost)
router.get('/quota/:channelId', verifyFirebaseToken, getMessageQuota);

// Stream webhook endpoint (no auth required - Stream calls this directly)
router.post('/webhook', handleStreamWebhook);

export default router;
