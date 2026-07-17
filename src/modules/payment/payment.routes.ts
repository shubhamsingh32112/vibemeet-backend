import { Router } from 'express';
import {
  createOrder,
  createWebOrder,
  getWalletPackages,
  handleRazorpayWebhook,
  initiateWebCheckout,
  verifyPayment,
  verifyWebPayment,
} from './payment.controller';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';
import { webhookLimiter } from '../../middlewares/rate-limit.middleware';
import { verifyRazorpayWebhookSignature } from '../../middlewares/webhook-signature.middleware';
import {
  getCheckoutStatus,
  recordHostedCheckoutResult,
} from '../checkout/checkout-return.service';

const router = Router();

// POST /payment/create-order — Create a Razorpay order for coin purchase
router.post('/create-order', verifyFirebaseToken, createOrder);

// POST /payment/verify — Verify Razorpay payment signature & credit coins
router.post('/verify', verifyFirebaseToken, verifyPayment);

// GET /payment/packages — Get user-specific wallet packages and tier pricing
router.get('/packages', verifyFirebaseToken, getWalletPackages);

// POST /payment/web/initiate — App starts a web checkout session (no Razorpay order here)
router.post('/web/initiate', verifyFirebaseToken, initiateWebCheckout);

// POST /payment/web/create-order — Website creates Razorpay order from checkout session
router.post('/web/create-order', createWebOrder);

// POST /payment/web/verify — Website verifies payment and returns app deep-link
router.post('/web/verify', verifyWebPayment);

// GET /payment/web/status/:checkoutId — authoritative cross-product checkout reconciliation
router.get('/web/status/:checkoutId', verifyFirebaseToken, getCheckoutStatus);
router.post('/web/result', recordHostedCheckoutResult);

// POST /payment/webhook — Razorpay webhook (signature protected + rate limited)
router.post('/webhook', webhookLimiter, verifyRazorpayWebhookSignature, handleRazorpayWebhook);

export default router;
