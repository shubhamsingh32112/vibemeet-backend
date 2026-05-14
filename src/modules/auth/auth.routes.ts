import { Router } from 'express';
import {
  login,
  logout,
  adminLogin,
  agencyLogin,
  bdLogin,
  fastLoginDeprecated,
  phonePrecheck,
} from './auth.controller';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import {
  fastLoginLimiter,
  loginLimiter,
  phonePrecheckLimiter,
} from '../../middlewares/rate-limit.middleware';

const router = Router();

router.post('/login', verifyFirebaseToken, loginLimiter, login);
router.post('/logout', verifyFirebaseToken, logout);
router.post('/phone-precheck', phonePrecheckLimiter, phonePrecheck);
router.post('/fast-login', fastLoginLimiter, fastLoginDeprecated);
router.post('/admin-login', loginLimiter, adminLogin);
router.post('/agency-login', loginLimiter, agencyLogin);
router.post('/bd-login', loginLimiter, bdLogin);

export default router;
