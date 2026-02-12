import { Router, Request, Response } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import { getIO } from '../../config/socket';
import { handleCallStartedHttp, settleCallHttp } from './billing.gateway';

const router = Router();

/**
 * REST API fallback for billing events.
 *
 * These endpoints exist as a **fallback** for when the Socket.IO connection
 * is not available on the client side (e.g., stale socket, network issue).
 * They invoke the same billing logic that the socket events do, so billing
 * is never silently dropped.
 */

// POST /api/v1/billing/call-started
router.post('/call-started', verifyFirebaseToken, async (req: Request, res: Response) => {
  try {
    const firebaseUid = req.auth?.firebaseUid;
    if (!firebaseUid) {
      res.status(401).json({ success: false, error: 'Not authenticated' });
      return;
    }

    const { callId, creatorFirebaseUid, creatorMongoId } = req.body;

    if (!callId || !creatorFirebaseUid || !creatorMongoId) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: callId, creatorFirebaseUid, creatorMongoId',
      });
      return;
    }

    console.log(`🌐 [BILLING REST] call-started from ${firebaseUid} for call ${callId}`);

    const io = getIO();
    await handleCallStartedHttp(io, firebaseUid, {
      callId,
      creatorFirebaseUid,
      creatorMongoId,
    });

    res.json({ success: true, message: 'Billing started' });
  } catch (err: any) {
    console.error('❌ [BILLING REST] call-started error:', err);
    res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// POST /api/v1/billing/call-ended
router.post('/call-ended', verifyFirebaseToken, async (req: Request, res: Response) => {
  try {
    const firebaseUid = req.auth?.firebaseUid;
    if (!firebaseUid) {
      res.status(401).json({ success: false, error: 'Not authenticated' });
      return;
    }

    const { callId } = req.body;

    if (!callId) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: callId',
      });
      return;
    }

    console.log(`🌐 [BILLING REST] call-ended from ${firebaseUid} for call ${callId}`);

    const io = getIO();
    await settleCallHttp(io, callId);

    res.json({ success: true, message: 'Billing ended / settled' });
  } catch (err: any) {
    console.error('❌ [BILLING REST] call-ended error:', err);
    res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

export default router;
