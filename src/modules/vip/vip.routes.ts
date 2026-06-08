import { Router } from 'express';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import { webhookLimiter } from '../../middlewares/rate-limit.middleware';
import { verifyRazorpayWebhookSignature } from '../../middlewares/webhook-signature.middleware';
import {
  createVipWebOrder,
  getVipPlan,
  getVipStatusHandler,
  handleVipRazorpayWebhook,
  initiateVipCheckout,
  verifyVipWebPayment,
} from './vip.controller';
import {
  cancelScheduledCallHandler,
  confirmScheduledCallHandler,
  getCallQueueStatus,
  leaveCallQueue,
  listIncomingScheduledCalls,
  listScheduledCalls,
  scheduleCall,
} from './vip-scheduling.controller';

const router = Router();

router.get('/plan', getVipPlan);
router.get('/status', verifyFirebaseToken, getVipStatusHandler);

router.post('/checkout/initiate', verifyFirebaseToken, initiateVipCheckout);
router.post('/checkout/create-order', createVipWebOrder);
router.post('/checkout/verify', verifyVipWebPayment);
router.post(
  '/webhook',
  webhookLimiter,
  verifyRazorpayWebhookSignature,
  handleVipRazorpayWebhook,
);

router.post('/calls/schedule', verifyFirebaseToken, scheduleCall);
router.get('/calls/scheduled', verifyFirebaseToken, listScheduledCalls);
router.get('/calls/scheduled/incoming', verifyFirebaseToken, listIncomingScheduledCalls);
router.post('/calls/scheduled/:id/confirm', verifyFirebaseToken, confirmScheduledCallHandler);
router.post('/calls/scheduled/:id/cancel', verifyFirebaseToken, cancelScheduledCallHandler);

router.get('/calls/queue', verifyFirebaseToken, getCallQueueStatus);
router.delete('/calls/queue', verifyFirebaseToken, leaveCallQueue);

export default router;
