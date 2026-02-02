import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import {
  initiateCall,
  acceptCall,
  endCall,
  rejectCall,
  getCallStatus,
  getIncomingCalls,
  getRecentCalls,
  rateCall,
} from './call.controller';

const router = Router();

// Recent calls (both users & creators)
router.get('/recent', verifyFirebaseToken, getRecentCalls);

// TASK 3: Get incoming calls for creator
router.get('/incoming', verifyFirebaseToken, getIncomingCalls);

// TASK 2: Create Call API
router.post('/initiate', verifyFirebaseToken, initiateCall);

// TASK 4: Accept Call API
router.post('/:callId/accept', verifyFirebaseToken, acceptCall);

// TASK 9: End Call API
router.post('/:callId/end', verifyFirebaseToken, endCall);

// TASK 10: Reject Call API
router.post('/:callId/reject', verifyFirebaseToken, rejectCall);

// Get call status (for polling)
router.get('/:callId/status', verifyFirebaseToken, getCallStatus);

// Rate a call (caller only)
router.post('/:callId/rating', verifyFirebaseToken, rateCall);

export default router;
