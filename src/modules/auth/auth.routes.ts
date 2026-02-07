import { Router } from 'express';
import { login, logout } from './auth.controller';
import { adminLogin } from './admin-auth.controller';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';

const router = Router();

// Firebase-authenticated routes (mobile app)
router.post('/login', verifyFirebaseToken, login);
router.post('/logout', verifyFirebaseToken, logout);

// Direct admin login (no Firebase client needed)
router.post('/admin-login', adminLogin);

export default router;
