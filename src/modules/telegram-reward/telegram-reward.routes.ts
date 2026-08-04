import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import {
  telegramLinkTokenLimiter,
  telegramStatusLimiter,
  telegramVerifyLimiter,
  telegramWebhookLimiter,
} from '../../middlewares/rate-limit.middleware';
import {
  createTelegramLinkTokenHandler,
  getTelegramRewardStatusHandler,
  telegramWebhookHandler,
  verifyTelegramRewardHandler,
} from './telegram-reward.controller';

const router = Router();

router.get(
  '/telegram/status',
  verifyFirebaseToken,
  telegramStatusLimiter,
  getTelegramRewardStatusHandler
);
router.post(
  '/telegram/link-token',
  verifyFirebaseToken,
  telegramLinkTokenLimiter,
  createTelegramLinkTokenHandler
);
router.post(
  '/telegram/verify',
  verifyFirebaseToken,
  telegramVerifyLimiter,
  verifyTelegramRewardHandler
);
router.post(
  '/telegram/webhook/:secret',
  telegramWebhookLimiter,
  telegramWebhookHandler
);

export default router;
