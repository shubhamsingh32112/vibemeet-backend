import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import {
  claimRewardsTaskHandler,
  getRewardsHubHandler,
} from './consumer-reward.controller';

const rewardsHubLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: 'Too many rewards hub requests.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    const firebaseUid =
      (req as { auth?: { firebaseUid?: string } }).auth?.firebaseUid || req.ip;
    return `rewards_hub:${firebaseUid}`;
  },
});

const rewardsClaimLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: 'Too many reward claim attempts.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    const firebaseUid =
      (req as { auth?: { firebaseUid?: string } }).auth?.firebaseUid || req.ip;
    return `rewards_claim:${firebaseUid}`;
  },
});

const router = Router();

router.get('/hub', verifyFirebaseToken, rewardsHubLimiter, getRewardsHubHandler);
router.post(
  '/tasks/:key/claim',
  verifyFirebaseToken,
  rewardsClaimLimiter,
  claimRewardsTaskHandler
);

export default router;
