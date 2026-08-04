import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import { checkInClaimLimiter } from '../../middlewares/rate-limit.middleware';
import {
  claimCheckIn,
  getCheckInStatus,
  registerPushToken,
  unregisterPushToken,
} from './checkin.controller';

const router = Router();

router.get('/status', verifyFirebaseToken, getCheckInStatus);
router.post('/claim', verifyFirebaseToken, checkInClaimLimiter, claimCheckIn);
router.post('/push-token', verifyFirebaseToken, registerPushToken);
router.delete('/push-token', verifyFirebaseToken, unregisterPushToken);

export default router;
