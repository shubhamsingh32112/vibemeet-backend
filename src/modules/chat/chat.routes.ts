import { Router } from 'express';
import {
  getChatToken,
  createOrGetChannel,
  preSendMessage,
  getMessageQuota,
  getCreatorCallInfo,
  getOtherMemberInfo,
} from './chat.controller';
import { handleStreamWebhook } from './chat.webhook';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import { chatLimiter } from '../../middlewares/rate-limit.middleware';

const router = Router();

// Get Stream Chat token
router.post('/token', verifyFirebaseToken, getChatToken);

// Create or get channel (returns quota info)
router.post('/channel', verifyFirebaseToken, createOrGetChannel);

// Pre-send check — frontend calls this BEFORE every user message
// Validates quota, deducts coins if needed
router.post('/pre-send', chatLimiter, verifyFirebaseToken, preSendMessage);

// Get message quota for a channel (free remaining, cost)
router.get('/quota/:channelId', chatLimiter, verifyFirebaseToken, getMessageQuota);

// Get other member info for chat header (when Stream state is incomplete)
router.get(
  '/channel/:channelId/other-member',
  chatLimiter,
  verifyFirebaseToken,
  getOtherMemberInfo,
);

// Get creator call info for video call from chat (when Stream extraData is missing)
router.get(
  '/channel/:channelId/creator-call-info',
  verifyFirebaseToken,
  getCreatorCallInfo,
);

// Stream webhook endpoint (no auth required - Stream calls this directly)
router.post('/webhook', handleStreamWebhook);

export default router;
