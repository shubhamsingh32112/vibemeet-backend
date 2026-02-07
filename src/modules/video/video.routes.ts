import { Router } from 'express';
import { getVideoToken, initiateCall, acceptCall } from './video.controller';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import { handleStreamVideoWebhook } from './video.webhook';

const router = Router();

// Get Stream Video token
// Backend only handles authentication and token generation
// Call creation is done via Flutter SDK (getOrCreate) - not via REST
router.post('/token', verifyFirebaseToken, getVideoToken);

// Initiate call (creates call record in DB)
router.post('/call/initiate', verifyFirebaseToken, initiateCall);

// Accept call (creator side - locks availability and snapshots price)
router.post('/call/accept', verifyFirebaseToken, acceptCall);

// Stream Video webhook endpoint (no auth required - Stream will call this directly)
// Note: In production, you should verify webhook signature or use IP whitelist
router.post('/webhook', handleStreamVideoWebhook);

export default router;
