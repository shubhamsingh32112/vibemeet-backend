import { Router } from 'express';
import {
  createOrder,
  createWebOrder,
  getWalletPackages,
  initiateWebCheckout,
  verifyPayment,
  verifyWebPayment,
} from './payment.controller';
import { verifyFirebaseToken } from '../../middlewares/auth.middleware';

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

export default router;
