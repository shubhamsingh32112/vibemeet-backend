import { Router } from 'express';
import { login, logout } from './auth.controller';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';

const router = Router();

router.post('/login', verifyFirebaseToken, login);
router.post('/logout', verifyFirebaseToken, logout);

export default router;
