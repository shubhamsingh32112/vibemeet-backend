import type { Request } from 'express';
import { Response } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { getRazorpayInstance } from '../../config/razorpay';
import { featureFlags } from '../../config/feature-flags';
import { logError, logInfo, logWarning } from '../../utils/logger';
import { User } from '../user/user.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { verifyUserBalance } from '../../utils/balance-integrity';
import { getIO } from '../../config/socket';
import {
  PricingTier,
  getEffectivePackPrice,
  getOrCreateWalletPricingConfig,
  hasCompletedCoinPurchase,
} from './wallet-pricing.model';
import { processReferralRewardOnPurchase } from '../user/referral.service';
import { finalizePaymentAtomically } from './payment-finalization.service';
import { PaymentWebhookEvent } from './payment-webhook-event.model';
import { recordPaymentMetric } from '../../utils/monitoring';

const CHECKOUT_SESSION_TTL_SECONDS = 15 * 60;
const WEB_CHECKOUT_BASE_URL = process.env.WEB_CHECKOUT_BASE_URL || 'http://localhost:8080';
const APP_RETURN_DEEP_LINK = process.env.APP_RETURN_DEEP_LINK || 'zztherapy://wallet';
const PAYMENT_WEBHOOK_MAX_RETRIES = Math.max(
  1,
  parseInt(process.env.PAYMENT_WEBHOOK_MAX_RETRIES || '6', 10) || 6
);
const PAYMENT_WEBHOOK_RETRY_BASE_MS = Math.max(
  500,
  parseInt(process.env.PAYMENT_WEBHOOK_RETRY_BASE_MS || '2000', 10) || 2000
);

interface CheckoutSessionPayload {
  firebaseUid: string;
  userId: string;
  packageId: string;
  coins: number;
  priceInr: number;
  pricingTier: PricingTier;
  iat?: number;
  exp?: number;
}

const getCheckoutSessionSecret = (): string =>
  (process.env.CHECKOUT_SESSION_SECRET || process.env.JWT_SECRET || 'checkout-session-secret-change-me').trim();

const normalizePackageId = (coins: number): string => `pack_${coins}`;

const getActiveCoinPackByPackageIdForTier = async (
  packageId: string,
  tier: PricingTier
): Promise<{ packageId: string; coins: number; priceInr: number } | null> => {
  const config = await getOrCreateWalletPricingConfig();
  const pack = config.packages
    .filter((p) => p.isActive)
    .find((p) => normalizePackageId(p.coins) === packageId);
  if (!pack) return null;
  return {
    packageId,
    coins: pack.coins,
    priceInr: getEffectivePackPrice(pack, tier),
  };
};

const getValidCoinsList = async (): Promise<number[]> => {
  const config = await getOrCreateWalletPricingConfig();
  return config.packages.filter((p) => p.isActive).map((p) => p.coins);
};

const resolveUserPricingTier = async (userId: string): Promise<PricingTier> => {
  const hasPurchased = await hasCompletedCoinPurchase(userId);
  return hasPurchased ? 'tier2' : 'tier1';
};

const buildAppOpenUrl = (params: Record<string, string>): string => {
  const [base, existingQuery] = APP_RETURN_DEEP_LINK.split('?');
  const query = new URLSearchParams(existingQuery || '');
  Object.entries(params).forEach(([key, value]) => query.set(key, value));
  return `${base}?${query.toString()}`;
};

const buildPaymentStatusDeepLink = (
  status: 'success' | 'failed',
  values: {
    sessionId?: string;
    walletDelta?: number;
    message?: string;
    reason?: string;
  } = {}
): string => {
  const params: Record<string, string> = {
    status,
    payment: status, // temporary backward compatibility for older app builds
  };
  if (values.sessionId) params.sessionId = values.sessionId;
  if (typeof values.walletDelta === 'number') {
    params.walletDelta = String(values.walletDelta);
    params.coinsAdded = String(values.walletDelta); // temporary backward compatibility
  }
  if (values.message) params.message = values.message;
  if (values.reason) params.reason = values.reason;
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

const signCheckoutSession = (payload: CheckoutSessionPayload): string =>
  jwt.sign(payload, getCheckoutSessionSecret(), { expiresIn: CHECKOUT_SESSION_TTL_SECONDS });

const verifyCheckoutSession = (checkoutToken: string): CheckoutSessionPayload | null => {
  try {
    const decoded = jwt.verify(checkoutToken, getCheckoutSessionSecret());
    if (!decoded || typeof decoded === 'string') return null;
    return decoded as CheckoutSessionPayload;
  } catch {
    return null;
  }
};

const verifyClientSignature = (
  razorpay_order_id: string,
  razorpay_payment_id: string,
  razorpay_signature: string
): boolean => {
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) {
    throw new Error('PAYMENT_VERIFICATION_UNAVAILABLE');
  }
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

interface ProviderPaymentVerificationResult {
  payment: any;
  order: any | null;
}

const verifyProviderPaymentCaptured = async (
  razorpay_order_id: string,
  razorpay_payment_id: string
): Promise<ProviderPaymentVerificationResult> => {
  if (featureFlags.mockPaymentProvider) {
    return {
      payment: {
        id: razorpay_payment_id,
        order_id: razorpay_order_id,
        status: 'captured',
      },
      order: null,
    };
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

const buildPendingTransactionId = (orderId: string): string => `pay_${orderId}`;

const getOrderTransactionSelectors = (orderId: string): Array<Record<string, string>> => [
  { transactionId: buildPendingTransactionId(orderId) },
  { transactionId: `razorpay_${orderId}` }, // backward compatibility with historical rows
  { paymentGatewayOrderId: orderId },
];

const findPendingTransactionByOrderId = async (orderId: string) =>
  CoinTransaction.findOne({ $or: getOrderTransactionSelectors(orderId) });

const createPendingCoinTransaction = async (
  userId: string,
  orderId: string,
  coins: number,
  priceInr: number
) => {
  const transaction = new CoinTransaction({
    transactionId: buildPendingTransactionId(orderId),
    userId,
    type: 'credit',
    coins,
    source: 'payment_gateway',
    description: `Purchase ${coins} coins for ₹${priceInr}`,
    paymentGatewayTransactionId: orderId,
    paymentGatewayOrderId: orderId,
    paymentGatewayProvider: 'razorpay',
    status: 'pending',
  });
  await transaction.save();
};

/**
 * POST /payment/create-order
 *
 * Creates a Razorpay order for purchasing coins.
 * Body: { coins: number }
 *
 * Returns the Razorpay order details that the Flutter app
 * needs to open the checkout.
 */
export const createOrder = async (req: Request, res: Response): Promise<void> => {
  void req;
  res.status(410).json({
    success: false,
    error: 'Deprecated endpoint. Use /payment/web/initiate from mobile clients.',
    errorCode: 'PAYMENT_APP_DIRECT_FLOW_DISABLED',
  });
};

/**
 * POST /payment/web/initiate
 *
 * App-only endpoint: creates a short-lived checkout session and returns
 * the website checkout URL. No Razorpay order is created in this step.
 */
export const initiateWebCheckout = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { packageId, coins } = req.body as { packageId?: string; coins?: number };
    if ((!packageId || typeof packageId !== 'string') && (!coins || typeof coins !== 'number')) {
      res.status(400).json({ success: false, error: 'Missing packageId' });
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
        error: 'Only regular users can purchase coins',
      });
      return;
    }

    const pricingTier = await resolveUserPricingTier(user._id.toString());
    const resolvedPackageId =
      packageId && packageId.trim().length > 0 ? packageId.trim() : normalizePackageId(coins!);
    const pack = await getActiveCoinPackByPackageIdForTier(resolvedPackageId, pricingTier);
    if (!pack) {
      const validCoins = await getValidCoinsList();
      res.status(400).json({
        success: false,
        error: `Invalid packageId. Valid package coins: ${validCoins.join(', ')}`,
      });
      return;
    }

    const checkoutToken = signCheckoutSession({
      firebaseUid: user.firebaseUid,
      userId: user._id.toString(),
      packageId: pack.packageId,
      coins: pack.coins,
      priceInr: pack.priceInr,
      pricingTier,
    });

    const checkoutBase = WEB_CHECKOUT_BASE_URL.replace(/\/$/, '');
    const checkoutParams = new URLSearchParams({
      session: checkoutToken,
      apiBase: resolveApiBaseUrlForCheckout(req),
    });
    const checkoutUrl = `${checkoutBase}/wallet-checkout?${checkoutParams.toString()}`;

    res.json({
      success: true,
      data: {
        checkoutUrl,
        sessionId: checkoutToken,
        packageId: pack.packageId,
        coins: pack.coins,
        priceInr: pack.priceInr,
        amount: pack.priceInr * 100,
        expiresInSeconds: CHECKOUT_SESSION_TTL_SECONDS,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown';
    console.error(`❌ [PAYMENT] initiateWebCheckout error: ${message}`);
    res.status(500).json({ success: false, error: 'Failed to initiate checkout' });
  }
};

/**
 * POST /payment/web/create-order
 *
 * Website endpoint: creates Razorpay order from short-lived checkout token.
 */
export const createWebOrder = async (req: Request, res: Response): Promise<void> => {
  try {
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
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    if (user._id.toString() !== session.userId || user.role !== 'user') {
      res.status(403).json({ success: false, error: 'Checkout session is not valid for this user' });
      return;
    }

    const pricingTier = await resolveUserPricingTier(user._id.toString());
    const activePack = await getActiveCoinPackByPackageIdForTier(session.packageId, pricingTier);
    if (!activePack) {
      res.status(400).json({ success: false, error: 'Invalid checkout session package' });
      return;
    }

    const razorpay = getRazorpayInstance();
    const amountInPaise = activePack.priceInr * 100;

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt: `web_c_${activePack.coins}_${Date.now()}`,
      notes: {
        userId: user._id.toString(),
        firebaseUid: user.firebaseUid,
        packageId: session.packageId,
        coins: activePack.coins.toString(),
        priceInr: activePack.priceInr.toString(),
        pricingTier: session.pricingTier,
      },
    });

    await createPendingCoinTransaction(user._id.toString(), order.id, activePack.coins, activePack.priceInr);

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
        coins: activePack.coins,
        keyId: process.env.RAZORPAY_KEY_ID,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown';
    console.error(`❌ [PAYMENT] createWebOrder error: ${message}`);
    res.status(500).json({ success: false, error: 'Failed to create checkout order' });
  }
};

/**
 * POST /payment/web/verify
 *
 * Website endpoint: verifies payment, credits coins, and returns app deep link.
 */
export const verifyWebPayment = async (req: Request, res: Response): Promise<void> => {
  const startedAt = Date.now();
  try {
    const {
      checkoutToken,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (!checkoutToken || typeof checkoutToken !== 'string') {
      recordPaymentMetric('web.verify_failed', 1, { reason: 'missing_checkout_token' });
      res.status(400).json({ success: false, error: 'Missing checkoutToken' });
      return;
    }

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      recordPaymentMetric('web.verify_failed', 1, { reason: 'missing_required_fields' });
      res.status(400).json({
        success: false,
        error: 'Missing required fields: razorpay_order_id, razorpay_payment_id, razorpay_signature',
      });
      return;
    }

    const session = verifyCheckoutSession(checkoutToken);
    if (!session) {
      recordPaymentMetric('web.verify_failed', 1, { reason: 'invalid_or_expired_session' });
      res.status(401).json({
        success: false,
        error: 'Invalid or expired checkout token',
        data: {
          appOpenUrl: buildPaymentStatusDeepLink('failed', { reason: 'session_expired' }),
        },
      });
      return;
    }

    const user = await User.findOne({ firebaseUid: session.firebaseUid });
    if (!user || user._id.toString() !== session.userId || user.role !== 'user') {
      recordPaymentMetric('web.verify_failed', 1, { reason: 'invalid_session_user' });
      res.status(403).json({
        success: false,
        error: 'Checkout session is not valid for this user',
        data: {
          appOpenUrl: buildPaymentStatusDeepLink('failed', { reason: 'invalid_session_user' }),
        },
      });
      return;
    }

    let signatureOk = false;
    try {
      signatureOk = verifyClientSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
    } catch {
      recordPaymentMetric('web.verify_failed', 1, { reason: 'signature_verifier_unavailable' });
      res.status(500).json({ success: false, error: 'Payment verification unavailable' });
      return;
    }

    if (!signatureOk) {
      recordPaymentMetric('web.verify_failed', 1, { reason: 'signature_mismatch' });
      await CoinTransaction.findOneAndUpdate(
        { $or: getOrderTransactionSelectors(razorpay_order_id) },
        { status: 'failed' }
      );
      res.status(400).json({
        success: false,
        error: 'Payment verification failed: Invalid signature',
        data: {
          appOpenUrl: buildPaymentStatusDeepLink('failed', {
            sessionId: checkoutToken,
            reason: 'signature_mismatch',
          }),
        },
      });
      return;
    }
    let providerOrder: any | null = null;
    try {
      const providerCheck = await verifyProviderPaymentCaptured(razorpay_order_id, razorpay_payment_id);
      providerOrder = providerCheck.order;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'PAYMENT_PROVIDER_ERROR';
      recordPaymentMetric('web.verify_failed', 1, { reason: 'provider_verification_failed' });
      const reason = message.startsWith('PAYMENT_NOT_CAPTURED')
        ? 'payment_not_captured'
        : message === 'PAYMENT_ORDER_MISMATCH'
          ? 'order_payment_mismatch'
          : 'provider_verification_failed';
      res.status(400).json({
        success: false,
        error: 'Payment provider verification failed',
        data: {
          appOpenUrl: buildPaymentStatusDeepLink('failed', { sessionId: checkoutToken, reason }),
        },
      });
      return;
    }

    if (providerOrder) {
      const notes = providerOrder.notes || {};
      if (notes.userId && String(notes.userId) !== user._id.toString()) {
        res.status(403).json({
          success: false,
          error: 'Payment user mismatch',
          data: {
            appOpenUrl: buildPaymentStatusDeepLink('failed', {
              sessionId: checkoutToken,
              reason: 'provider_user_mismatch',
            }),
          },
        });
        return;
      }
    }

    const transaction = await findPendingTransactionByOrderId(razorpay_order_id);
    if (!transaction) {
      res.status(404).json({
        success: false,
        error: 'Transaction not found',
        data: {
          appOpenUrl: buildPaymentStatusDeepLink('failed', {
            sessionId: checkoutToken,
            reason: 'txn_not_found',
          }),
        },
      });
      return;
    }
    if (transaction.userId.toString() !== user._id.toString()) {
      res.status(403).json({
        success: false,
        error: 'Transaction does not belong to this user',
        data: {
          appOpenUrl: buildPaymentStatusDeepLink('failed', {
            sessionId: checkoutToken,
            reason: 'txn_user_mismatch',
          }),
        },
      });
      return;
    }

    if (providerOrder?.notes?.coins && Number(providerOrder.notes.coins) !== transaction.coins) {
      res.status(400).json({
        success: false,
        error: 'Provider coin pack mismatch',
        data: {
          appOpenUrl: buildPaymentStatusDeepLink('failed', {
            sessionId: checkoutToken,
            reason: 'provider_coin_mismatch',
          }),
        },
      });
      return;
    }

    let finalizeResult;
    try {
      finalizeResult = await finalizePaymentAtomically({
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
        expectedUserId: user._id.toString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'UNKNOWN_FINALIZE_ERROR';
      const statusCode =
        message === 'TRANSACTION_NOT_FOUND'
          ? 404
          : message === 'TRANSACTION_USER_MISMATCH'
            ? 403
            : 500;
      const reason =
        message === 'TRANSACTION_NOT_FOUND'
          ? 'txn_not_found'
          : message === 'TRANSACTION_USER_MISMATCH'
            ? 'txn_user_mismatch'
            : 'finalize_error';
      res.status(statusCode).json({
        success: false,
        error: 'Failed to finalize payment',
        data: {
          appOpenUrl: buildPaymentStatusDeepLink('failed', {
            sessionId: checkoutToken,
            reason,
          }),
        },
      });
      return;
    }

    verifyUserBalance(user._id).catch(() => {});

    if (finalizeResult.status === 'completed') {
      try {
        const io = getIO();
        io.to(`user:${user.firebaseUid}`).emit('coins_updated', {
          userId: user._id.toString(),
          coins: finalizeResult.updatedUserCoins,
        });
      } catch (socketErr) {
        const message = socketErr instanceof Error ? socketErr.message : 'unknown';
        logWarning('Failed to emit payment coins_updated', {
          message,
          orderId: razorpay_order_id,
          paymentId: razorpay_payment_id,
          userFirebaseUid: user.firebaseUid,
        });
      }
    }

    const referralPriceInr = providerOrder?.notes?.priceInr
      ? parseInt(String(providerOrder.notes.priceInr), 10)
      : session.priceInr ?? 0;
    if (finalizeResult.status === 'completed') {
      processReferralRewardOnPurchase(user._id, referralPriceInr).catch((err) => {
        const message = err instanceof Error ? err.message : 'unknown';
        logWarning('Referral reward processing failed (non-fatal)', {
          message,
          userId: user._id.toString(),
          orderId: razorpay_order_id,
        });
      });
    }

    recordPaymentMetric('web.verify_success', 1, {
      finalizeStatus: finalizeResult.status,
    });
    recordPaymentMetric('web.verify_duration_ms', Date.now() - startedAt, {
      status: 'success',
    });
    logInfo('Web payment verification completed', {
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      userId: user._id.toString(),
      finalizeStatus: finalizeResult.status,
    });

    res.json({
      success: true,
      data: {
        message:
          finalizeResult.status === 'already_completed'
            ? 'Payment already verified'
            : 'Payment verified successfully',
        coins: finalizeResult.updatedUserCoins,
        walletDelta: finalizeResult.coinsAdded,
        coinsAdded: finalizeResult.coinsAdded,
        sessionId: checkoutToken,
        transactionRef: finalizeResult.transaction._id.toString(),
        appOpenUrl: buildPaymentStatusDeepLink('success', {
          sessionId: checkoutToken,
          walletDelta: finalizeResult.coinsAdded,
        }),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown';
    recordPaymentMetric('web.verify_failed', 1, { reason: 'internal_error' });
    recordPaymentMetric('web.verify_duration_ms', Date.now() - startedAt, {
      status: 'failed',
    });
    logError('verifyWebPayment error', error, { message });
    res.status(500).json({
      success: false,
      error: 'Payment verification failed',
      data: {
        appOpenUrl: buildPaymentStatusDeepLink('failed', { reason: 'internal_error' }),
      },
    });
  }
};

/**
 * POST /payment/verify
 *
 * App/API endpoint: verifies signature + provider capture + credits coins atomically.
 */
export const verifyPayment = async (req: Request, res: Response): Promise<void> => {
  void req;
  res.status(410).json({
    success: false,
    error: 'Deprecated endpoint. Use /payment/web/initiate from mobile clients.',
    errorCode: 'PAYMENT_APP_DIRECT_FLOW_DISABLED',
  });
};

interface RazorpayWebhookPayload {
  event?: string;
  payload?: {
    payment?: { entity?: any };
    order?: { entity?: any };
  };
  created_at?: number;
}

interface PaymentWebhookProcessResult {
  outcome: 'processed' | 'ignored' | 'already_processed' | 'failed' | 'retryable_failed';
  reason?: string;
}

function getWebhookRawBody(req: Request): Buffer {
  return Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(req.body === undefined || req.body === null ? '' : JSON.stringify(req.body), 'utf8');
}

const parseRazorpayWebhookPayload = (body: unknown): RazorpayWebhookPayload => {
  if (Buffer.isBuffer(body)) {
    const raw = body.toString('utf8');
    return raw.trim() ? (JSON.parse(raw) as RazorpayWebhookPayload) : {};
  }
  return (body || {}) as RazorpayWebhookPayload;
};

const buildWebhookAuditPayload = (payload: RazorpayWebhookPayload): Record<string, unknown> => ({
  event: payload.event || null,
  created_at: payload.created_at || null,
  paymentId: payload.payload?.payment?.entity?.id || null,
  orderId:
    payload.payload?.payment?.entity?.order_id || payload.payload?.order?.entity?.id || null,
});

const isRetriableWebhookFailure = (message: string): boolean => {
  if (!message) return true;
  if (message.startsWith('PAYMENT_ORDER_MISMATCH')) return false;
  if (message.startsWith('TRANSACTION_USER_MISMATCH')) return false;
  if (message.startsWith('TRANSACTION_NOT_FOUND')) return false;
  return true;
};

const computeNextRetryAt = (attemptCount: number): Date => {
  const exponent = Math.max(0, attemptCount - 1);
  const delay = Math.min(60_000, PAYMENT_WEBHOOK_RETRY_BASE_MS * 2 ** exponent);
  return new Date(Date.now() + delay);
};

const buildDeterministicWebhookEventId = (
  req: Request,
  eventType: string,
  paymentId: string,
  orderId: string
): string => {
  const providerEventId = req.headers['x-razorpay-event-id'];
  if (typeof providerEventId === 'string' && providerEventId.trim().length > 0) {
    return `rzp:${providerEventId.trim()}`;
  }
  const fingerprint = crypto.createHash('sha256').update(getWebhookRawBody(req)).digest('hex');
  const entityRef = paymentId || orderId || 'unknown';
  return `rzp:${eventType}:${entityRef}:${fingerprint}`;
};

async function processStoredRazorpayWebhookEvent(
  eventDocId: string
): Promise<PaymentWebhookProcessResult> {
  const now = new Date();
  const claimed = await PaymentWebhookEvent.findOneAndUpdate(
    {
      _id: eventDocId,
      status: { $in: ['received', 'failed'] },
      $or: [{ nextRetryAt: { $exists: false } }, { nextRetryAt: null }, { nextRetryAt: { $lte: now } }],
    },
    {
      $set: {
        status: 'processing',
        lastAttemptAt: now,
      },
      $inc: { attemptCount: 1 },
    },
    { new: true }
  );

  if (!claimed) {
    const existing = await PaymentWebhookEvent.findById(eventDocId).lean();
    if (existing?.status === 'processed') {
      return { outcome: 'already_processed' };
    }
    return { outcome: 'ignored', reason: 'not_eligible_for_processing' };
  }

  const eventType = claimed.eventType || 'unknown';
  const paymentId = claimed.paymentId || '';
  const orderId = claimed.orderId || '';

  if (!paymentId || !orderId) {
    await PaymentWebhookEvent.findByIdAndUpdate(claimed._id, {
      status: 'failed',
      failureReason: 'missing_payment_or_order_id',
      nextRetryAt: null,
    });
    recordPaymentMetric('webhook.process_failed', 1, { reason: 'missing_ids', eventType });
    return { outcome: 'failed', reason: 'missing_payment_or_order_id' };
  }

  if (!['payment.captured', 'order.paid'].includes(eventType)) {
    await PaymentWebhookEvent.findByIdAndUpdate(claimed._id, {
      status: 'processed',
      processedAt: new Date(),
      failureReason: undefined,
      nextRetryAt: null,
    });
    recordPaymentMetric('webhook.ignored', 1, { eventType });
    return { outcome: 'ignored' };
  }

  const processStartedAt = Date.now();
  try {
    await verifyProviderPaymentCaptured(orderId, paymentId);
    const finalizeResult = await finalizePaymentAtomically({ orderId, paymentId });
    await PaymentWebhookEvent.findByIdAndUpdate(claimed._id, {
      status: 'processed',
      processedAt: new Date(),
      failureReason: undefined,
      nextRetryAt: null,
    });

    recordPaymentMetric('webhook.processed', 1, {
      eventType,
      finalizeStatus: finalizeResult.status,
    });
    recordPaymentMetric('webhook.process_latency_ms', Date.now() - processStartedAt, {
      eventType,
    });
    return { outcome: 'processed' };
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : 'webhook_processing_error';
    const retriable =
      claimed.attemptCount < PAYMENT_WEBHOOK_MAX_RETRIES && isRetriableWebhookFailure(failureReason);
    await PaymentWebhookEvent.findByIdAndUpdate(claimed._id, {
      status: 'failed',
      failureReason,
      nextRetryAt: retriable ? computeNextRetryAt(claimed.attemptCount) : null,
    });

    recordPaymentMetric('webhook.process_failed', 1, {
      eventType,
      reason: failureReason,
      retriable: retriable ? 'true' : 'false',
    });

    if (retriable) {
      return { outcome: 'retryable_failed', reason: failureReason };
    }
    return { outcome: 'failed', reason: failureReason };
  }
}

export async function retryFailedPaymentWebhooks(limit: number = 20): Promise<number> {
  const now = new Date();
  const candidates = await PaymentWebhookEvent.find({
    status: { $in: ['received', 'failed'] },
    $or: [{ nextRetryAt: { $exists: false } }, { nextRetryAt: null }, { nextRetryAt: { $lte: now } }],
  })
    .sort({ createdAt: 1 })
    .limit(Math.max(1, limit))
    .lean();

  let processed = 0;
  for (const event of candidates) {
    const result = await processStoredRazorpayWebhookEvent(event._id.toString());
    if (result.outcome === 'processed' || result.outcome === 'ignored' || result.outcome === 'already_processed') {
      processed += 1;
    }
  }
  if (candidates.length > 0) {
    recordPaymentMetric('webhook.retry_scan_size', candidates.length);
    recordPaymentMetric('webhook.retry_processed', processed);
  }
  return processed;
}

export const handleRazorpayWebhook = async (req: Request, res: Response): Promise<void> => {
  let payload: RazorpayWebhookPayload = {};
  try {
    payload = parseRazorpayWebhookPayload(req.body);
  } catch {
    res.status(400).json({ success: false, error: 'Invalid JSON body' });
    return;
  }

  try {
    const eventType = String(payload.event || 'unknown');
    const paymentEntity = payload.payload?.payment?.entity;
    const orderEntity = payload.payload?.order?.entity;
    const paymentId = String(paymentEntity?.id || '');
    const orderId = String(paymentEntity?.order_id || orderEntity?.id || '');
    const eventId = buildDeterministicWebhookEventId(req, eventType, paymentId, orderId);

    let eventDoc;
    try {
      eventDoc = await PaymentWebhookEvent.create({
        eventId,
        eventType,
        paymentId: paymentId || undefined,
        orderId: orderId || undefined,
        status: 'received',
        attemptCount: 0,
        rawPayload: buildWebhookAuditPayload(payload),
      });
    } catch (error: any) {
      if (error?.code === 11000) {
        recordPaymentMetric('webhook.duplicate', 1, { eventType });
        res.status(200).json({ success: true, duplicate: true });
        return;
      }
      throw error;
    }

    recordPaymentMetric('webhook.received', 1, { eventType });
    logInfo('Razorpay webhook received', {
      eventId,
      eventType,
      orderId,
      paymentId,
    });

    const processResult = await processStoredRazorpayWebhookEvent(eventDoc._id.toString());
    if (processResult.outcome === 'retryable_failed') {
      logWarning('Razorpay webhook processing failed with retry scheduled', {
        eventId,
        eventType,
        reason: processResult.reason,
      });
      res.status(500).json({
        success: false,
        error: 'Webhook processing failed; retry scheduled',
      });
      return;
    }

    if (processResult.outcome === 'failed') {
      logWarning('Razorpay webhook processing failed permanently', {
        eventId,
        eventType,
        reason: processResult.reason,
      });
      res.status(200).json({
        success: true,
        processed: false,
        reason: processResult.reason,
      });
      return;
    }

    res.status(200).json({ success: true, processed: true, outcome: processResult.outcome });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown';
    logError('Razorpay webhook handler error', error, {
      message,
    });
    recordPaymentMetric('webhook.handler_error', 1);
    res.status(500).json({ success: false, error: 'Failed to process webhook' });
  }
};

/**
 * GET /payment/packages
 *
 * Returns active wallet coin packages with effective user pricing tier.
 */
export const getWalletPackages = async (req: Request, res: Response): Promise<void> => {
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

    if (user.role !== 'user') {
      res.status(403).json({
        success: false,
        error: 'Only regular users can purchase coins',
      });
      return;
    }

    const pricingTier = await resolveUserPricingTier(user._id.toString());
    const hasPurchasedCoinPackage = pricingTier === 'tier2';
    const config = await getOrCreateWalletPricingConfig();

    const packages = config.packages
      .filter((p) => p.isActive)
      .sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return a.coins - b.coins;
      })
      .map((p) => ({
        packageId: normalizePackageId(p.coins),
        coins: p.coins,
        priceInr: getEffectivePackPrice(p, pricingTier),
        oldPriceInr: p.oldPriceInr,
        badge: p.badge,
        sortOrder: p.sortOrder,
      }));

    res.json({
      success: true,
      data: {
        pricingTier,
        hasPurchasedCoinPackage,
        packages,
        pricingUpdatedAt: config.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown';
    console.error(`❌ [PAYMENT] getWalletPackages error: ${message}`);
    res.status(500).json({ success: false, error: 'Failed to fetch wallet packages' });
  }
};
