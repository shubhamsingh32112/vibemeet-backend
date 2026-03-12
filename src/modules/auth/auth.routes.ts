import { Router } from 'express';
import { login, logout, adminLogin, fastLogin } from './auth.controller';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import { fastLoginLimiter, loginLimiter } from '../../middlewares/rate-limit.middleware';

const router = Router();

// Firebase-authenticated routes (mobile app)
router.post('/login', verifyFirebaseToken, loginLimiter, login);
router.post('/logout', verifyFirebaseToken, logout);

// Fast Login — device fingerprint + install ID (no auth); rate-limited by IP
router.post('/fast-login', fastLoginLimiter, fastLogin);

// Admin login — email + password (no Firebase token)
router.post('/admin-login', adminLogin);

export default router;
