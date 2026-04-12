import { Router } from 'express';
import { login, logout, adminLogin, agentLogin, fastLoginDeprecated } from './auth.controller';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import { fastLoginLimiter, loginLimiter } from '../../middlewares/rate-limit.middleware';

const router = Router();

// Firebase-authenticated routes (mobile app)
router.post('/login', verifyFirebaseToken, loginLimiter, login);
router.post('/logout', verifyFirebaseToken, logout);

// Legacy: Fast Login removed — 410 Gone for old clients (rate-limited)
router.post('/fast-login', fastLoginLimiter, fastLoginDeprecated);

// Admin login — email + password (no Firebase token)
router.post('/admin-login', loginLimiter, adminLogin);

// Agent login — email + password (bcrypt on User.passwordHash)
router.post('/agent-login', loginLimiter, agentLogin);

export default router;
