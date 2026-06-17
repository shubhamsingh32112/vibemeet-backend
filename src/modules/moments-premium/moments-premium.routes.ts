import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import { webhookLimiter } from '../../middlewares/rate-limit.middleware';
import { verifyRazorpayWebhookSignature } from '../../middlewares/webhook-signature.middleware';
import {
  createMomentsPremiumWebOrder,
  getMomentsPremiumPlan,
  getMomentsPremiumStatusHandler,
  handleMomentsPremiumRazorpayWebhook,
  initiateMomentsPremiumCheckout,
  verifyMomentsPremiumWebPayment,
} from './moments-premium.controller';

const router = Router();

router.get('/plan', getMomentsPremiumPlan);
router.get('/status', verifyFirebaseToken, getMomentsPremiumStatusHandler);

router.post('/checkout/initiate', verifyFirebaseToken, initiateMomentsPremiumCheckout);
router.post('/checkout/create-order', createMomentsPremiumWebOrder);
router.post('/checkout/verify', verifyMomentsPremiumWebPayment);
router.post(
  '/webhook',
  webhookLimiter,
  verifyRazorpayWebhookSignature,
  handleMomentsPremiumRazorpayWebhook,
);

export default router;
