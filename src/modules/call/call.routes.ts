import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import {
  initiateCall,
  acceptCall,
  endCall,
  rejectCall,
  getCallStatus,
  getIncomingCalls,
} from './call.controller';

const router = Router();

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

// TASK 3: Get incoming calls for creator
router.get('/incoming', verifyFirebaseToken, getIncomingCalls);

export default router;
