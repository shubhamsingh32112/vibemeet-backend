import { Router } from 'express';
import { getVideoToken } from './video.controller';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';

const router = Router();

// Get Stream Video token
// Backend only handles authentication and token generation
// Call creation is done via Flutter SDK (getOrCreate) - not via REST
router.post('/token', verifyFirebaseToken, getVideoToken);

export default router;
