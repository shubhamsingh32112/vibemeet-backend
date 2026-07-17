import type { Request } from 'express';
import { Response } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { getRazorpayInstance } from '../../config/razorpay';
import { featureFlags } from '../../config/feature-flags';
import { logError, logInfo } from '../../utils/logger';
import { User } from '../user/user.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { getOrCreateVipPlans, getVipPlanById } from './models/vip-plan-config.model';
import { VipPurchaseEvent } from './models/vip-purchase-event.model';
import {
  VIP_CHECKOUT_SESSION_TTL_SECONDS,
  VIP_PLAN_ID,
} from './vip.config';
import {
  buildLegacyPlanPayload,
  buildSharedPerks,
  buildVipPlanApiShape,
} from './vip-plan-response.util';
import { getVipStatus } from './vip-entitlement.service';
import {
  createPendingVipTransaction,
  finalizeVipPurchaseAtomically,
  findPendingVipTransaction,
  buildVipPurchaseTxnId,
} from './vip-purchase-finalization.service';
import {
  attachCheckoutOrder,
  buildNeutralReturnTargets,
  buildReturnTarget,
  createCheckoutContext,
  InvalidReturnToError,
  recoverSignedNavigationClaims,
  recordCheckoutResult,
} from '../checkout/checkout-return.service';
import { observeCapturedPaymentBestEffort } from '../payment/razorpay-captured-payment-projection.service';

const WEB_CHECKOUT_BASE_URL =
  process.env.WEB_CHECKOUT_BASE_URL ||
  (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8080');
const VIP_APP_RETURN_DEEP_LINK = process.env.VIP_APP_RETURN_DEEP_LINK || 'zztherapy://vip';

interface VipCheckoutSessionPayload {
  firebaseUid: string;
  userId: string;
  planId: string;
  priceInr: number;
  durationDays: number;
  checkoutId?: string;
  checkoutOrigin?: 'app' | 'web';
  returnTo?: string;
  iat?: number;
  exp?: number;
}

const getCheckoutSessionSecret = (): string =>
  (process.env.CHECKOUT_SESSION_SECRET || process.env.JWT_SECRET || 'checkout-session-secret-change-me').trim();

const signVipCheckoutSession = (payload: VipCheckoutSessionPayload): string =>
  jwt.sign(payload, getCheckoutSessionSecret(), {
    expiresIn: VIP_CHECKOUT_SESSION_TTL_SECONDS,
  });

const verifyVipCheckoutSession = (
  checkoutToken: string,
): VipCheckoutSessionPayload | null => {
  try {
    const decoded = jwt.verify(checkoutToken, getCheckoutSessionSecret());
    if (!decoded || typeof decoded === 'string') return null;
    return decoded as VipCheckoutSessionPayload;
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

const buildVipAppOpenUrl = (params: Record<string, string>): string => {
  const [base, existingQuery] = VIP_APP_RETURN_DEEP_LINK.split('?');
  const query = new URLSearchParams(existingQuery || '');
  Object.entries(params).forEach(([key, value]) => query.set(key, value));
  return `${base}?${query.toString()}`;
};

const buildVipStatusDeepLink = (
  status: 'success' | 'failed',
  values: { sessionId?: string; message?: string; reason?: string; expiresAt?: string } = {},
): string => {
  const params: Record<string, string> = { status, payment: status };
  if (values.sessionId) params.sessionId = values.sessionId;
  if (values.message) params.message = values.message;
  if (values.reason) params.reason = values.reason;
  if (values.expiresAt) params.expiresAt = values.expiresAt;
  return buildVipAppOpenUrl(params);
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

export const getVipPlan = async (_req: Request, res: Response): Promise<void> => {
  try {
    const plans = await getOrCreateVipPlans();
    const monthlyPlan = plans.find((p) => p.planId === VIP_PLAN_ID) ?? plans[0];
    const perks = buildSharedPerks(plans);
    const vipEnabled = featureFlags.vipEnabled;
    const planShapes = plans.map((plan) =>
      buildVipPlanApiShape(plan, monthlyPlan, vipEnabled),
    );
    const legacyPlan = buildLegacyPlanPayload(monthlyPlan, perks, vipEnabled);

    res.json({
      success: true,
      data: {
        ...legacyPlan,
        vipEnabled,
        plans: planShapes,
        perks,
        plan: legacyPlan,
      },
    });
  } catch (error) {
    logError('vip_get_plan_failed', error);
    res.status(500).json({ success: false, error: 'Failed to load VIP plan' });
  }
};

export const getVipStatusHandler = async (
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
    const status = await getVipStatus(user._id);
    res.json({ success: true, data: status });
  } catch (error) {
    logError('vip_get_status_failed', error);
    res.status(500).json({ success: false, error: 'Failed to load VIP status' });
  }
};

export const initiateVipCheckout = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    if (!featureFlags.vipEnabled) {
      res.status(503).json({ success: false, error: 'VIP is not available yet' });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    if (user.role !== 'user') {
      res.status(403).json({ success: false, error: 'Only regular users can purchase VIP' });
      return;
    }

    const requestedPlanId =
      typeof req.body?.planId === 'string' && req.body.planId.trim().length > 0
        ? req.body.planId.trim()
        : VIP_PLAN_ID;

    const plan = await getVipPlanById(requestedPlanId);
    if (!plan || !plan.isActive) {
      res.status(400).json({ success: false, error: 'Invalid or inactive VIP plan' });
      return;
    }

    const navigation = await createCheckoutContext({
      userId: user._id,
      product: 'vip',
      checkoutOrigin: req.body?.checkoutOrigin,
      returnTo: req.body?.returnTo,
    });
    const checkoutToken = signVipCheckoutSession({
      firebaseUid: user.firebaseUid,
      userId: user._id.toString(),
      planId: plan.planId,
      priceInr: plan.priceInr,
      durationDays: plan.durationDays,
      ...navigation,
    });

    const checkoutBase = WEB_CHECKOUT_BASE_URL.replace(/\/$/, '');
    if (!checkoutBase) throw new Error('WEB_CHECKOUT_BASE_URL is required');
    const checkoutParams = new URLSearchParams({ session: checkoutToken });
    const checkoutUrl = `${checkoutBase}/vip-checkout?${checkoutParams.toString()}`;

    res.json({
      success: true,
      data: {
        checkoutUrl,
        checkoutId: navigation.checkoutId,
        sessionId: checkoutToken,
        planId: plan.planId,
        priceInr: plan.priceInr,
        durationDays: plan.durationDays,
        amount: plan.priceInr * 100,
        expiresInSeconds: VIP_CHECKOUT_SESSION_TTL_SECONDS,
      },
    });
  } catch (error) {
    if (error instanceof InvalidReturnToError || (error instanceof Error && error.message === 'Invalid checkoutOrigin')) {
      res.status(400).json({ success: false, error: error.message });
      return;
    }
    logError('vip_initiate_checkout_failed', error);
    res.status(500).json({ success: false, error: 'Failed to initiate VIP checkout' });
  }
};

export const createVipWebOrder = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (!featureFlags.vipEnabled) {
      res.status(503).json({ success: false, error: 'VIP is not available yet' });
      return;
    }

    const { checkoutToken } = req.body;
    if (!checkoutToken || typeof checkoutToken !== 'string') {
      res.status(400).json({ success: false, error: 'Missing checkoutToken' });
      return;
    }

    const session = verifyVipCheckoutSession(checkoutToken);
    if (!session) {
      const navigation = recoverSignedNavigationClaims(checkoutToken);
      res.status(401).json({
        success: false,
        error: 'Invalid or expired checkout token',
        returnTargets: navigation
          ? buildNeutralReturnTargets(
              navigation,
              (status, reason) => buildVipStatusDeepLink(status, { reason }),
            )
          : undefined,
      });
      return;
    }

    const user = await User.findOne({ firebaseUid: session.firebaseUid });
    if (!user || user._id.toString() !== session.userId || user.role !== 'user') {
      res.status(403).json({ success: false, error: 'Checkout session is not valid for this user' });
      return;
    }

    const plan = await getVipPlanById(session.planId);
    if (!plan || !plan.isActive) {
      res.status(400).json({ success: false, error: 'Invalid VIP plan in session' });
      return;
    }
    if (
      session.priceInr !== plan.priceInr ||
      session.durationDays !== plan.durationDays
    ) {
      res.status(400).json({ success: false, error: 'VIP plan pricing mismatch' });
      return;
    }

    const amountInPaise = plan.priceInr * 100;
    const razorpay = getRazorpayInstance();
    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt: `vip_${Date.now()}`,
      notes: {
        userId: user._id.toString(),
        firebaseUid: user.firebaseUid,
        planId: plan.planId,
        productType: 'vip_membership',
        priceInr: plan.priceInr.toString(),
        durationDays: plan.durationDays.toString(),
      },
    });

    await createPendingVipTransaction(
      user._id.toString(),
      order.id,
      plan.priceInr,
      plan.planId,
    );
    await attachCheckoutOrder(session.checkoutId, order.id);

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
        checkoutId: session.checkoutId,
        returnTargets: buildNeutralReturnTargets(
          session,
          (status, reason) => buildVipStatusDeepLink(status, { reason }),
        ),
        appOpenUrl: buildVipStatusDeepLink('failed', { reason: 'cancelled' }),
      },
    });
  } catch (error) {
    logError('vip_create_web_order_failed', error);
    res.status(500).json({ success: false, error: 'Failed to create VIP order' });
  }
};

export const verifyVipWebPayment = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (!featureFlags.vipEnabled) {
      res.status(503).json({ success: false, error: 'VIP is not available yet' });
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

    const session = verifyVipCheckoutSession(checkoutToken);
    if (!session) {
      const navigation = recoverSignedNavigationClaims(checkoutToken);
      res.status(401).json({
        success: false,
        error: 'Invalid or expired checkout token',
        data: {
          returnTarget: navigation
            ? buildReturnTarget(
                navigation,
                'failed',
                (status, reason) => buildVipStatusDeepLink(status, { reason }),
                'session_expired',
              )
            : undefined,
          appOpenUrl: buildVipStatusDeepLink('failed', { reason: 'session_expired' }),
        },
      });
      return;
    }

    const user = await User.findOne({ firebaseUid: session.firebaseUid });
    if (!user || user._id.toString() !== session.userId || user.role !== 'user') {
      res.status(403).json({
        success: false,
        error: 'Checkout session is not valid for this user',
        data: { appOpenUrl: buildVipStatusDeepLink('failed', { reason: 'invalid_session_user' }) },
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
      await recordCheckoutResult(session.checkoutId, 'failed', { reason: 'signature_mismatch' });
      await CoinTransaction.findOneAndUpdate(
        { transactionId: buildVipPurchaseTxnId(razorpay_order_id) },
        { status: 'failed' },
      );
      res.status(400).json({
        success: false,
        error: 'Invalid payment signature',
        data: {
          appOpenUrl: buildVipStatusDeepLink('failed', {
            sessionId: checkoutToken,
            reason: 'signature_mismatch',
          }),
        },
      });
      return;
    }

    let providerPayment: unknown;
    try {
      const providerCheck = await verifyProviderPaymentCaptured(razorpay_order_id, razorpay_payment_id);
      providerPayment = providerCheck.payment;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'provider_error';
      const pending = message.startsWith('PAYMENT_NOT_CAPTURED') || message === 'provider_error';
      res.status(pending ? 202 : 400).json({
        success: false,
        error: pending ? 'Payment confirmation pending' : 'Payment provider verification failed',
        data: {
          returnTarget: buildReturnTarget(
            session,
            pending ? 'pending' : 'failed',
            (status, reason) => buildVipStatusDeepLink(status, { reason }),
            message,
          ),
          appOpenUrl: buildVipStatusDeepLink('failed', {
            sessionId: checkoutToken,
            reason: message,
          }),
        },
      });
      return;
    }

    const pendingTxn = await findPendingVipTransaction(razorpay_order_id);
    if (!pendingTxn || pendingTxn.userId.toString() !== user._id.toString()) {
      res.status(404).json({
        success: false,
        error: 'VIP transaction not found',
        data: {
          appOpenUrl: buildVipStatusDeepLink('failed', {
            sessionId: checkoutToken,
            reason: 'txn_not_found',
          }),
        },
      });
      return;
    }

    const plan = await getVipPlanById(session.planId);
    if (!plan) {
      res.status(400).json({
        success: false,
        error: 'Invalid VIP plan in session',
        data: {
          appOpenUrl: buildVipStatusDeepLink('failed', {
            sessionId: checkoutToken,
            reason: 'invalid_plan',
          }),
        },
      });
      return;
    }

    const result = await finalizeVipPurchaseAtomically({
      userId: user._id.toString(),
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      priceInr: session.priceInr,
      planId: session.planId,
      durationDays: plan.durationDays,
    });
    await observeCapturedPaymentBestEffort(providerPayment, 'vip_verification');

    logInfo('vip_purchase_completed', {
      userId: user._id.toString(),
      orderId: razorpay_order_id,
      expiresAt: result.expiresAt.toISOString(),
      alreadyProcessed: result.alreadyProcessed,
    });
    await recordCheckoutResult(session.checkoutId, 'success', {
      expiresAt: result.expiresAt.toISOString(),
    });

    res.json({
      success: true,
      data: {
        checkoutId: session.checkoutId,
        returnTarget: buildReturnTarget(
          session,
          'success',
          (status, reason) => buildVipStatusDeepLink(status, { reason }),
        ),
        appOpenUrl: buildVipStatusDeepLink('success', {
          sessionId: checkoutToken,
          expiresAt: result.expiresAt.toISOString(),
          message: 'VIP activated successfully',
        }),
        expiresAt: result.expiresAt.toISOString(),
        alreadyProcessed: result.alreadyProcessed,
      },
    });
  } catch (error) {
    logError('vip_verify_web_payment_failed', error);
    res.status(500).json({
      success: false,
      error: 'Failed to verify VIP payment',
      data: { appOpenUrl: buildVipStatusDeepLink('failed', { reason: 'finalize_error' }) },
    });
  }
};

export const handleVipRazorpayWebhook = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (!featureFlags.vipEnabled) {
      res.status(503).json({ success: false, error: 'VIP is not available yet' });
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
    const existing = await VipPurchaseEvent.findOne({ eventId });
    if (existing?.status === 'processed') {
      res.json({ success: true, message: 'Already processed' });
      return;
    }

    await VipPurchaseEvent.findOneAndUpdate(
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
      if (notes.productType !== 'vip_membership') {
        res.json({ success: true, message: 'Not a VIP order — ignored' });
        return;
      }

      const userId = notes.userId;
      if (!userId) {
        res.status(400).json({ success: false, error: 'Missing userId in order notes' });
        return;
      }

      const planId = notes.planId || VIP_PLAN_ID;
      const plan = await getVipPlanById(planId);
      const durationDays = plan?.durationDays;
      const priceInr = notes.priceInr
        ? Number.parseInt(String(notes.priceInr), 10)
        : plan?.priceInr ?? 0;

      await finalizeVipPurchaseAtomically({
        userId,
        orderId,
        paymentId,
        priceInr,
        planId,
        durationDays,
      });
      await observeCapturedPaymentBestEffort(paymentEntity, 'vip_webhook');

      await VipPurchaseEvent.updateOne(
        { eventId },
        { $set: { status: 'processed', processedAt: new Date(), userId } },
      );
    }

    res.json({ success: true });
  } catch (error) {
    logError('vip_webhook_failed', error);
    res.status(500).json({ success: false, error: 'Webhook processing failed' });
  }
};
