import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import { getOnlineUsers, resolveUsersByFirebaseUids } from './availability.controller';

const router = Router();

// Creator/admin only (validated inside controller)
router.get('/online-users', verifyFirebaseToken, getOnlineUsers);
router.post('/resolve-users', verifyFirebaseToken, resolveUsersByFirebaseUids);

export default router;

