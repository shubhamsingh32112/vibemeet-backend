import type { Request } from 'express';
import { Response } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { getRazorpayInstance } from '../../config/razorpay';
import { featureFlags } from '../../config/feature-flags';
import { isMomentsEnabled } from '../../config/moments';
import { logError, logInfo } from '../../utils/logger';
import { User } from '../user/user.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { getOrCreateMomentsPremiumPlans, getMomentsPremiumPlanById } from './models/moments-premium-plan-config.model';
import { MomentsPremiumPurchaseEvent } from './models/moments-premium-purchase-event.model';
import {
  MOMENTS_PREMIUM_CHECKOUT_SESSION_TTL_SECONDS,
  MOMENTS_PREMIUM_DEFAULT_PLAN_ID,
} from './moments-premium.config';
import { buildMomentsPremiumPlanApiShape } from './moments-premium-plan-response.util';
import { getMomentsPremiumStatus } from './moments-premium-entitlement.service';
import {
  createPendingMomentsPremiumTransaction,
  finalizeMomentsPremiumPurchaseAtomically,
  findPendingMomentsPremiumTransaction,
  buildMomentsPremiumPurchaseTxnId,
} from './moments-premium-purchase-finalization.service';

const WEB_CHECKOUT_BASE_URL = process.env.WEB_CHECKOUT_BASE_URL || 'http://localhost:8080';
const MOMENTS_PREMIUM_APP_RETURN_DEEP_LINK =
  process.env.MOMENTS_PREMIUM_APP_RETURN_DEEP_LINK || 'zztherapy://moments-plan';

interface MomentsPremiumCheckoutSessionPayload {
  firebaseUid: string;
  userId: string;
  planId: string;
  priceInr: number;
  durationDays: number;
  iat?: number;
  exp?: number;
}

const getCheckoutSessionSecret = (): string =>
  (process.env.CHECKOUT_SESSION_SECRET || process.env.JWT_SECRET || 'checkout-session-secret-change-me').trim();

const signCheckoutSession = (payload: MomentsPremiumCheckoutSessionPayload): string =>
  jwt.sign(payload, getCheckoutSessionSecret(), {
    expiresIn: MOMENTS_PREMIUM_CHECKOUT_SESSION_TTL_SECONDS,
  });

const verifyCheckoutSession = (
  checkoutToken: string,
): MomentsPremiumCheckoutSessionPayload | null => {
  try {
    const decoded = jwt.verify(checkoutToken, getCheckoutSessionSecret());
    if (!decoded || typeof decoded === 'string') return null;
    return decoded as MomentsPremiumCheckoutSessionPayload;
  } catch {
    return null;
  }
};

const verifyClientSignature = (
  razorpay_order_id: string,
  razorpay_payment_id: string,
  razorpay_signature: string,
): boolean => {
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) throw new Error('PAYMENT_VERIFICATION_UNAVAILABLE');
  const generatedSignature = crypto
    .createHmac('sha256', keySecret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');
  try {
    const expected = Buffer.from(generatedSignature, 'hex');
    const received = Buffer.from(String(razorpay_signature), 'hex');
    if (expected.length !== received.length) return false;
    return crypto.timingSafeEqual(expected, received);
  } catch {
    return false;
  }
};

const buildAppOpenUrl = (params: Record<string, string>): string => {
  const [base, existingQuery] = MOMENTS_PREMIUM_APP_RETURN_DEEP_LINK.split('?');
  const query = new URLSearchParams(existingQuery || '');
  Object.entries(params).forEach(([key, value]) => query.set(key, value));
  return `${base}?${query.toString()}`;
};

const buildStatusDeepLink = (
  status: 'success' | 'failed',
  values: { sessionId?: string; message?: string; reason?: string; expiresAt?: string } = {},
): string => {
  const params: Record<string, string> = { status, payment: status };
  if (values.sessionId) params.sessionId = values.sessionId;
  if (values.message) params.message = values.message;
  if (values.reason) params.reason = values.reason;
  if (values.expiresAt) params.expiresAt = values.expiresAt;
  return buildAppOpenUrl(params);
};

const resolveApiBaseUrlForCheckout = (req: Request): string => {
  const explicit =
    process.env.PUBLIC_API_BASE_URL ||
    process.env.API_BASE_URL ||
    process.env.BACKEND_PUBLIC_URL;
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim().replace(/\/$/, '');
  }
  const host = req.get('host');
  if (host && host.trim().length > 0) {
    return `${req.protocol}://${host}/api/v1`;
  }
  return 'http://localhost:3000/api/v1';
};

const verifyProviderPaymentCaptured = async (
  razorpay_order_id: string,
  razorpay_payment_id: string,
) => {
  if (featureFlags.mockPaymentProvider) {
    return { payment: { status: 'captured' }, order: null };
  }
  const razorpay = getRazorpayInstance();
  const payment = await razorpay.payments.fetch(razorpay_payment_id);
  if (!payment || payment.order_id !== razorpay_order_id) {
    throw new Error('PAYMENT_ORDER_MISMATCH');
  }
  if (payment.status !== 'captured') {
    throw new Error(`PAYMENT_NOT_CAPTURED:${payment.status || 'unknown'}`);
  }
  const order = await razorpay.orders.fetch(razorpay_order_id);
  return { payment, order };
};

export const getMomentsPremiumPlan = async (_req: Request, res: Response): Promise<void> => {
  try {
    const plans = await getOrCreateMomentsPremiumPlans();
    const momentsEnabled = isMomentsEnabled();
    const planShapes = plans.map((plan) =>
      buildMomentsPremiumPlanApiShape(plan, momentsEnabled),
    );

    res.json({
      success: true,
      data: {
        momentsPremiumEnabled: momentsEnabled,
        plans: planShapes,
      },
    });
  } catch (error) {
    logError('moments_premium_get_plan_failed', error);
    res.status(500).json({ success: false, error: 'Failed to load Moments Premium plans' });
  }
};

export const getMomentsPremiumStatusHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    const status = await getMomentsPremiumStatus(user._id);
    res.json({ success: true, data: status });
  } catch (error) {
    logError('moments_premium_get_status_failed', error);
    res.status(500).json({ success: false, error: 'Failed to load Moments Premium status' });
  }
};

export const initiateMomentsPremiumCheckout = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    if (!isMomentsEnabled()) {
      res.status(503).json({ success: false, error: 'Moments Premium is not available yet' });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    if (user.role !== 'user') {
      res.status(403).json({
        success: false,
        error: 'Only regular users can purchase Moments Premium',
      });
      return;
    }

    const requestedPlanId =
      typeof req.body?.planId === 'string' && req.body.planId.trim().length > 0
        ? req.body.planId.trim()
        : MOMENTS_PREMIUM_DEFAULT_PLAN_ID;

    const plan = await getMomentsPremiumPlanById(requestedPlanId);
    if (!plan || !plan.isActive) {
      res.status(400).json({ success: false, error: 'Invalid or inactive Moments Premium plan' });
      return;
    }

    const checkoutToken = signCheckoutSession({
      firebaseUid: user.firebaseUid,
      userId: user._id.toString(),
      planId: plan.planId,
      priceInr: plan.priceInr,
      durationDays: plan.durationDays,
    });

    const checkoutBase = WEB_CHECKOUT_BASE_URL.replace(/\/$/, '');
    const checkoutParams = new URLSearchParams({
      session: checkoutToken,
      apiBase: resolveApiBaseUrlForCheckout(req),
    });
    const checkoutUrl = `${checkoutBase}/moments-premium-checkout?${checkoutParams.toString()}`;

    res.json({
      success: true,
      data: {
        checkoutUrl,
        sessionId: checkoutToken,
        planId: plan.planId,
        priceInr: plan.priceInr,
        durationDays: plan.durationDays,
        amount: plan.priceInr * 100,
        expiresInSeconds: MOMENTS_PREMIUM_CHECKOUT_SESSION_TTL_SECONDS,
      },
    });
  } catch (error) {
    logError('moments_premium_initiate_checkout_failed', error);
    res.status(500).json({ success: false, error: 'Failed to initiate Moments Premium checkout' });
  }
};

export const createMomentsPremiumWebOrder = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (!isMomentsEnabled()) {
      res.status(503).json({ success: false, error: 'Moments Premium is not available yet' });
      return;
    }

    const { checkoutToken } = req.body;
    if (!checkoutToken || typeof checkoutToken !== 'string') {
      res.status(400).json({ success: false, error: 'Missing checkoutToken' });
      return;
    }

    const session = verifyCheckoutSession(checkoutToken);
    if (!session) {
      res.status(401).json({ success: false, error: 'Invalid or expired checkout token' });
      return;
    }

    const user = await User.findOne({ firebaseUid: session.firebaseUid });
    if (!user || user._id.toString() !== session.userId || user.role !== 'user') {
      res.status(403).json({
        success: false,
        error: 'Checkout session is not valid for this user',
      });
      return;
    }

    const plan = await getMomentsPremiumPlanById(session.planId);
    if (!plan || !plan.isActive) {
      res.status(400).json({ success: false, error: 'Invalid Moments Premium plan in session' });
      return;
    }
    if (
      session.priceInr !== plan.priceInr ||
      session.durationDays !== plan.durationDays
    ) {
      res.status(400).json({ success: false, error: 'Moments Premium plan pricing mismatch' });
      return;
    }

    const amountInPaise = plan.priceInr * 100;
    const razorpay = getRazorpayInstance();
    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt: `moments_premium_${Date.now()}`,
      notes: {
        userId: user._id.toString(),
        firebaseUid: user.firebaseUid,
        planId: plan.planId,
        productType: 'moments_premium_membership',
        priceInr: plan.priceInr.toString(),
        durationDays: plan.durationDays.toString(),
      },
    });

    await createPendingMomentsPremiumTransaction(
      user._id.toString(),
      order.id,
      plan.priceInr,
      plan.planId,
    );

    if (!process.env.RAZORPAY_KEY_ID) {
      res.status(500).json({ success: false, error: 'Payment checkout is currently unavailable' });
      return;
    }

    res.json({
      success: true,
      data: {
        orderId: order.id,
        amount: amountInPaise,
        currency: 'INR',
        planId: plan.planId,
        durationDays: plan.durationDays,
        priceInr: plan.priceInr,
        label: plan.label,
        keyId: process.env.RAZORPAY_KEY_ID,
      },
    });
  } catch (error) {
    logError('moments_premium_create_web_order_failed', error);
    res.status(500).json({ success: false, error: 'Failed to create Moments Premium order' });
  }
};

export const verifyMomentsPremiumWebPayment = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (!isMomentsEnabled()) {
      res.status(503).json({ success: false, error: 'Moments Premium is not available yet' });
      return;
    }

    const {
      checkoutToken,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (!checkoutToken || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      res.status(400).json({ success: false, error: 'Missing required payment fields' });
      return;
    }

    const session = verifyCheckoutSession(checkoutToken);
    if (!session) {
      res.status(401).json({
        success: false,
        error: 'Invalid or expired checkout token',
        data: { appOpenUrl: buildStatusDeepLink('failed', { reason: 'session_expired' }) },
      });
      return;
    }

    const user = await User.findOne({ firebaseUid: session.firebaseUid });
    if (!user || user._id.toString() !== session.userId || user.role !== 'user') {
      res.status(403).json({
        success: false,
        error: 'Checkout session is not valid for this user',
        data: { appOpenUrl: buildStatusDeepLink('failed', { reason: 'invalid_session_user' }) },
      });
      return;
    }

    let signatureOk = false;
    try {
      signatureOk = verifyClientSignature(
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
      );
    } catch {
      res.status(500).json({ success: false, error: 'Payment verification unavailable' });
      return;
    }

    if (!signatureOk) {
      await CoinTransaction.findOneAndUpdate(
        { transactionId: buildMomentsPremiumPurchaseTxnId(razorpay_order_id) },
        { status: 'failed' },
      );
      res.status(400).json({
        success: false,
        error: 'Invalid payment signature',
        data: {
          appOpenUrl: buildStatusDeepLink('failed', {
            sessionId: checkoutToken,
            reason: 'signature_mismatch',
          }),
        },
      });
      return;
    }

    try {
      await verifyProviderPaymentCaptured(razorpay_order_id, razorpay_payment_id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'provider_error';
      res.status(400).json({
        success: false,
        error: 'Payment provider verification failed',
        data: {
          appOpenUrl: buildStatusDeepLink('failed', {
            sessionId: checkoutToken,
            reason: message,
          }),
        },
      });
      return;
    }

    const pendingTxn = await findPendingMomentsPremiumTransaction(razorpay_order_id);
    if (!pendingTxn || pendingTxn.userId.toString() !== user._id.toString()) {
      res.status(404).json({
        success: false,
        error: 'Moments Premium transaction not found',
        data: {
          appOpenUrl: buildStatusDeepLink('failed', {
            sessionId: checkoutToken,
            reason: 'txn_not_found',
          }),
        },
      });
      return;
    }

    const plan = await getMomentsPremiumPlanById(session.planId);
    if (!plan) {
      res.status(400).json({
        success: false,
        error: 'Invalid Moments Premium plan in session',
        data: {
          appOpenUrl: buildStatusDeepLink('failed', {
            sessionId: checkoutToken,
            reason: 'invalid_plan',
          }),
        },
      });
      return;
    }

    const result = await finalizeMomentsPremiumPurchaseAtomically({
      userId: user._id.toString(),
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      priceInr: session.priceInr,
      planId: session.planId,
      durationDays: plan.durationDays,
    });

    logInfo('moments_premium_purchase_completed', {
      userId: user._id.toString(),
      orderId: razorpay_order_id,
      expiresAt: result.expiresAt.toISOString(),
      alreadyProcessed: result.alreadyProcessed,
    });

    res.json({
      success: true,
      data: {
        appOpenUrl: buildStatusDeepLink('success', {
          sessionId: checkoutToken,
          expiresAt: result.expiresAt.toISOString(),
          message: 'Moments Premium activated successfully',
        }),
        expiresAt: result.expiresAt.toISOString(),
        alreadyProcessed: result.alreadyProcessed,
      },
    });
  } catch (error) {
    logError('moments_premium_verify_web_payment_failed', error);
    res.status(500).json({
      success: false,
      error: 'Failed to verify Moments Premium payment',
      data: { appOpenUrl: buildStatusDeepLink('failed', { reason: 'finalize_error' }) },
    });
  }
};

export const handleMomentsPremiumRazorpayWebhook = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (!isMomentsEnabled()) {
      res.status(503).json({ success: false, error: 'Moments Premium is not available yet' });
      return;
    }

    const payload = req.body as {
      event?: string;
      payload?: {
        payment?: { entity?: Record<string, unknown> };
        order?: { entity?: Record<string, unknown> };
      };
    };

    const eventType = payload.event || 'unknown';
    const paymentEntity = payload.payload?.payment?.entity;
    const orderEntity = payload.payload?.order?.entity;

    const paymentId = paymentEntity?.id ? String(paymentEntity.id) : undefined;
    const orderId =
      (paymentEntity?.order_id ? String(paymentEntity.order_id) : undefined) ||
      (orderEntity?.id ? String(orderEntity.id) : undefined);

    const eventId = `${eventType}:${orderId || 'no-order'}:${paymentId || 'no-payment'}`;
    const existing = await MomentsPremiumPurchaseEvent.findOne({ eventId });
    if (existing?.status === 'processed') {
      res.json({ success: true, message: 'Already processed' });
      return;
    }

    await MomentsPremiumPurchaseEvent.findOneAndUpdate(
      { eventId },
      {
        $setOnInsert: {
          eventId,
          eventType,
          orderId,
          paymentId,
          rawPayload: payload,
          status: 'received',
        },
        $inc: { attemptCount: 1 },
        $set: { lastAttemptAt: new Date() },
      },
      { upsert: true, new: true },
    );

    if (
      eventType === 'payment.captured' &&
      orderId &&
      paymentId &&
      paymentEntity?.status === 'captured'
    ) {
      const notes = (paymentEntity.notes || orderEntity?.notes || {}) as Record<string, string>;
      if (notes.productType !== 'moments_premium_membership') {
        res.json({ success: true, message: 'Not a Moments Premium order — ignored' });
        return;
      }

      const userId = notes.userId;
      if (!userId) {
        res.status(400).json({ success: false, error: 'Missing userId in order notes' });
        return;
      }

      const planId = notes.planId || MOMENTS_PREMIUM_DEFAULT_PLAN_ID;
      const plan = await getMomentsPremiumPlanById(planId);
      const durationDays = plan?.durationDays;
      const priceInr = notes.priceInr
        ? Number.parseInt(String(notes.priceInr), 10)
        : plan?.priceInr ?? 0;

      await finalizeMomentsPremiumPurchaseAtomically({
        userId,
        orderId,
        paymentId,
        priceInr,
        planId,
        durationDays,
      });

      await MomentsPremiumPurchaseEvent.updateOne(
        { eventId },
        { $set: { status: 'processed', processedAt: new Date(), userId } },
      );
    }

    res.json({ success: true });
  } catch (error) {
    logError('moments_premium_webhook_failed', error);
    res.status(500).json({ success: false, error: 'Webhook processing failed' });
  }
};
