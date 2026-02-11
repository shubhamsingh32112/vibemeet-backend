import { Router } from 'express';
import { login, logout, adminLogin } from './auth.controller';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';

const router = Router();

// Firebase-authenticated routes (mobile app)
router.post('/login', verifyFirebaseToken, login);
router.post('/logout', verifyFirebaseToken, logout);

// Admin login — email + password (no Firebase token)
router.post('/admin-login', adminLogin);

export default router;
