import type { Request } from 'express';
import { Response } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { getRazorpayInstance } from '../../config/razorpay';
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

const CHECKOUT_SESSION_TTL_SECONDS = 15 * 60;
const WEB_CHECKOUT_BASE_URL = process.env.WEB_CHECKOUT_BASE_URL || 'http://localhost:8080';
const APP_RETURN_DEEP_LINK = process.env.APP_RETURN_DEEP_LINK || 'zztherapy://wallet';

interface CheckoutSessionPayload {
  firebaseUid: string;
  userId: string;
  coins: number;
  priceInr: number;
  pricingTier: PricingTier;
  iat?: number;
  exp?: number;
}

const getCheckoutSessionSecret = (): string =>
  (process.env.CHECKOUT_SESSION_SECRET || process.env.JWT_SECRET || 'checkout-session-secret-change-me').trim();

const getActiveCoinPackForTier = async (
  coins: number,
  tier: PricingTier
): Promise<{ coins: number; priceInr: number } | null> => {
  const config = await getOrCreateWalletPricingConfig();
  const pack = config.packages
    .filter((p) => p.isActive)
    .find((p) => p.coins === coins);
  if (!pack) return null;
  return {
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

const createPendingCoinTransaction = async (
  userId: string,
  orderId: string,
  coins: number,
  priceInr: number
) => {
  const transaction = new CoinTransaction({
    transactionId: `razorpay_${orderId}`,
    userId,
    type: 'credit',
    coins,
    source: 'payment_gateway',
    description: `Purchase ${coins} coins for ₹${priceInr}`,
    paymentGatewayTransactionId: orderId,
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
  try {
    console.log('💳 [PAYMENT] Create order request');

    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { coins } = req.body;

    if (!coins || typeof coins !== 'number' || coins <= 0) {
      res.status(400).json({
        success: false,
        error: 'Invalid coins amount',
      });
      return;
    }

    // Only allow regular users to purchase coins
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
    const pack = await getActiveCoinPackForTier(coins, pricingTier);
    if (!pack) {
      const validCoins = await getValidCoinsList();
      res.status(400).json({
        success: false,
        error: `Invalid coin package. Valid packages: ${validCoins.join(', ')}`,
      });
      return;
    }

    // Create Razorpay order
    // Amount is in paise (smallest currency subunit): ₹75 = 7500 paise
    const razorpay = getRazorpayInstance();
    const amountInPaise = pack.priceInr * 100;

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt: `c_${pack.coins}_${Date.now()}`,
      notes: {
        userId: user._id.toString(),
        coins: pack.coins.toString(),
        priceInr: pack.priceInr.toString(),
      },
    });

    console.log(`✅ [PAYMENT] Order created: ${order.id} for ${pack.coins} coins (₹${pack.priceInr})`);
    console.log(`   User: ${user._id}`);

    // Create a pending transaction record so we can track it
    const transaction = new CoinTransaction({
      transactionId: `razorpay_${order.id}`,
      userId: user._id,
      type: 'credit',
      coins: pack.coins,
      source: 'payment_gateway',
      description: `Purchase ${pack.coins} coins for ₹${pack.priceInr}`,
      paymentGatewayTransactionId: order.id,
      status: 'pending',
    });
    await transaction.save();

    console.log(`📝 [PAYMENT] Pending transaction created: ${transaction.transactionId}`);

    res.json({
      success: true,
      data: {
        orderId: order.id,
        amount: amountInPaise,
        currency: 'INR',
        coins: pack.coins,
        keyId: process.env.RAZORPAY_KEY_ID, // Public key for frontend checkout
      },
    });
  } catch (error) {
    console.error('❌ [PAYMENT] Create order error:', error);
    res.status(500).json({ success: false, error: 'Failed to create order' });
  }
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

    const { coins } = req.body;
    if (!coins || typeof coins !== 'number' || coins <= 0) {
      res.status(400).json({ success: false, error: 'Invalid coins amount' });
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
    const pack = await getActiveCoinPackForTier(coins, pricingTier);
    if (!pack) {
      const validCoins = await getValidCoinsList();
      res.status(400).json({
        success: false,
        error: `Invalid coin package. Valid packages: ${validCoins.join(', ')}`,
      });
      return;
    }

    const checkoutToken = signCheckoutSession({
      firebaseUid: user.firebaseUid,
      userId: user._id.toString(),
      coins: pack.coins,
      priceInr: pack.priceInr,
      pricingTier,
    });

    const checkoutUrl = `${WEB_CHECKOUT_BASE_URL.replace(/\/$/, '')}/wallet-checkout?session=${encodeURIComponent(checkoutToken)}`;

    res.json({
      success: true,
      data: {
        checkoutUrl,
        coins: pack.coins,
        priceInr: pack.priceInr,
        amount: pack.priceInr * 100,
        expiresInSeconds: CHECKOUT_SESSION_TTL_SECONDS,
      },
    });
  } catch (error) {
    console.error('❌ [PAYMENT] initiateWebCheckout error:', error);
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

    const validCoins = await getValidCoinsList();
    if (!validCoins.includes(session.coins)) {
      res.status(400).json({ success: false, error: 'Invalid checkout session package' });
      return;
    }

    const razorpay = getRazorpayInstance();
    const amountInPaise = session.priceInr * 100;

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt: `web_c_${session.coins}_${Date.now()}`,
      notes: {
        userId: user._id.toString(),
        firebaseUid: user.firebaseUid,
        coins: session.coins.toString(),
        priceInr: session.priceInr.toString(),
        pricingTier: session.pricingTier,
      },
    });

    await createPendingCoinTransaction(user._id.toString(), order.id, session.coins, session.priceInr);

    if (!process.env.RAZORPAY_KEY_ID) {
      res.status(500).json({ success: false, error: 'RAZORPAY_KEY_ID is not configured' });
      return;
    }

    res.json({
      success: true,
      data: {
        orderId: order.id,
        amount: amountInPaise,
        currency: 'INR',
        coins: session.coins,
        keyId: process.env.RAZORPAY_KEY_ID,
      },
    });
  } catch (error) {
    console.error('❌ [PAYMENT] createWebOrder error:', error);
    res.status(500).json({ success: false, error: 'Failed to create checkout order' });
  }
};

/**
 * POST /payment/web/verify
 *
 * Website endpoint: verifies payment, credits coins, and returns app deep link.
 */
export const verifyWebPayment = async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      checkoutToken,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (!checkoutToken || typeof checkoutToken !== 'string') {
      res.status(400).json({ success: false, error: 'Missing checkoutToken' });
      return;
    }

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: razorpay_order_id, razorpay_payment_id, razorpay_signature',
      });
      return;
    }

    const session = verifyCheckoutSession(checkoutToken);
    if (!session) {
      res.status(401).json({
        success: false,
        error: 'Invalid or expired checkout token',
        data: {
          appOpenUrl: buildAppOpenUrl({ payment: 'failed', reason: 'session_expired' }),
        },
      });
      return;
    }

    const user = await User.findOne({ firebaseUid: session.firebaseUid });
    if (!user || user._id.toString() !== session.userId || user.role !== 'user') {
      res.status(403).json({
        success: false,
        error: 'Checkout session is not valid for this user',
        data: {
          appOpenUrl: buildAppOpenUrl({ payment: 'failed', reason: 'invalid_session_user' }),
        },
      });
      return;
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      res.status(500).json({ success: false, error: 'Payment verification unavailable' });
      return;
    }

    const generatedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (generatedSignature !== razorpay_signature) {
      await CoinTransaction.findOneAndUpdate(
        { transactionId: `razorpay_${razorpay_order_id}` },
        { status: 'failed' }
      );
      res.status(400).json({
        success: false,
        error: 'Payment verification failed: Invalid signature',
        data: {
          appOpenUrl: buildAppOpenUrl({
            payment: 'failed',
            orderId: razorpay_order_id,
          }),
        },
      });
      return;
    }

    // Best-practice S2S verification:
    // Ensure payment belongs to this order and is captured before crediting coins.
    const razorpay = getRazorpayInstance();
    const razorpayPayment = await razorpay.payments.fetch(razorpay_payment_id);
    if (!razorpayPayment || razorpayPayment.order_id !== razorpay_order_id) {
      res.status(400).json({
        success: false,
        error: 'Payment order mismatch',
        data: {
          appOpenUrl: buildAppOpenUrl({ payment: 'failed', reason: 'order_payment_mismatch' }),
        },
      });
      return;
    }

    if (razorpayPayment.status !== 'captured') {
      res.status(400).json({
        success: false,
        error: `Payment is not captured. Current status: ${razorpayPayment.status}`,
        data: {
          appOpenUrl: buildAppOpenUrl({ payment: 'failed', reason: 'payment_not_captured' }),
        },
      });
      return;
    }

    const transaction = await CoinTransaction.findOne({
      transactionId: `razorpay_${razorpay_order_id}`,
    });

    if (!transaction) {
      res.status(404).json({
        success: false,
        error: 'Transaction not found',
        data: {
          appOpenUrl: buildAppOpenUrl({ payment: 'failed', reason: 'txn_not_found' }),
        },
      });
      return;
    }

    if (transaction.userId.toString() !== user._id.toString()) {
      res.status(403).json({
        success: false,
        error: 'Transaction does not belong to this user',
        data: {
          appOpenUrl: buildAppOpenUrl({ payment: 'failed', reason: 'txn_user_mismatch' }),
        },
      });
      return;
    }

    let coinsAdded = 0;
    if (transaction.status !== 'completed') {
      coinsAdded = transaction.coins;
      transaction.status = 'completed';
      transaction.paymentGatewayTransactionId = razorpay_payment_id;
      await transaction.save();

      user.coins = (user.coins || 0) + coinsAdded;
      await user.save();

      verifyUserBalance(user._id).catch(() => {});

      try {
        const io = getIO();
        io.to(`user:${user.firebaseUid}`).emit('coins_updated', {
          userId: user._id.toString(),
          coins: user.coins,
        });
      } catch (socketErr) {
        console.error('⚠️ [PAYMENT] Failed to emit coins_updated:', socketErr);
      }

      // Referral reward: grant 60 coins to referrer if purchase >= ₹100
      const priceInr = session.priceInr ?? 0;
      processReferralRewardOnPurchase(user._id, priceInr).catch((err) =>
        console.error('⚠️ [PAYMENT] Referral reward error (non-fatal):', err)
      );
    }

    res.json({
      success: true,
      data: {
        message: 'Payment verified successfully',
        coins: user.coins,
        coinsAdded,
        transactionId: transaction.transactionId,
        appOpenUrl: buildAppOpenUrl({
          payment: 'success',
          coinsAdded: coinsAdded.toString(),
          orderId: razorpay_order_id,
        }),
      },
    });
  } catch (error) {
    console.error('❌ [PAYMENT] verifyWebPayment error:', error);
    res.status(500).json({
      success: false,
      error: 'Payment verification failed',
      data: {
        appOpenUrl: buildAppOpenUrl({ payment: 'failed', reason: 'internal_error' }),
      },
    });
  }
};

/**
 * POST /payment/verify
 *
 * Verifies the Razorpay payment signature and credits coins to the user.
 * Body: {
 *   razorpay_order_id: string,
 *   razorpay_payment_id: string,
 *   razorpay_signature: string,
 * }
 */
export const verifyPayment = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('🔐 [PAYMENT] Verify payment request');

    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: razorpay_order_id, razorpay_payment_id, razorpay_signature',
      });
      return;
    }

    // Find the user
    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    // ── Step 1: Verify the payment signature ──
    // generated_signature = hmac_sha256(order_id + "|" + razorpay_payment_id, secret)
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      console.error('❌ [PAYMENT] RAZORPAY_KEY_SECRET not configured');
      res.status(500).json({ success: false, error: 'Payment verification unavailable' });
      return;
    }

    const generatedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (generatedSignature !== razorpay_signature) {
      console.error(`❌ [PAYMENT] Signature mismatch for order ${razorpay_order_id}`);
      console.error(`   Expected: ${generatedSignature}`);
      console.error(`   Received: ${razorpay_signature}`);

      // Mark the pending transaction as failed
      await CoinTransaction.findOneAndUpdate(
        { transactionId: `razorpay_${razorpay_order_id}` },
        { status: 'failed' }
      );

      res.status(400).json({
        success: false,
        error: 'Payment verification failed: Invalid signature',
      });
      return;
    }

    console.log(`✅ [PAYMENT] Signature verified for order ${razorpay_order_id}`);

    // ── Step 2: Find and update the pending transaction ──
    const transaction = await CoinTransaction.findOne({
      transactionId: `razorpay_${razorpay_order_id}`,
    });

    if (!transaction) {
      console.error(`❌ [PAYMENT] Transaction not found for order ${razorpay_order_id}`);
      res.status(404).json({ success: false, error: 'Transaction not found' });
      return;
    }

    // Check if already completed (idempotency)
    if (transaction.status === 'completed') {
      console.log(`⚠️  [PAYMENT] Transaction already completed: ${transaction.transactionId}`);
      res.json({
        success: true,
        data: {
          message: 'Payment already verified',
          coins: user.coins,
          coinsAdded: transaction.coins,
        },
      });
      return;
    }

    // Verify the transaction belongs to this user
    if (transaction.userId.toString() !== user._id.toString()) {
      console.error(`❌ [PAYMENT] Transaction user mismatch: expected ${user._id}, got ${transaction.userId}`);
      res.status(403).json({ success: false, error: 'Transaction does not belong to this user' });
      return;
    }

    // ── Step 3: Credit coins and mark transaction as completed ──
    const coinsToAdd = transaction.coins;
    const oldBalance = user.coins;

    // Update transaction status and add payment ID
    transaction.status = 'completed';
    transaction.paymentGatewayTransactionId = razorpay_payment_id;
    await transaction.save();

    // Credit coins to user
    user.coins = (user.coins || 0) + coinsToAdd;
    await user.save();

    console.log(`✅ [PAYMENT] Coins credited: ${oldBalance} → ${user.coins} (+${coinsToAdd})`);

    // Referral reward: grant 60 coins to referrer if purchase >= ₹100
    const razorpay = getRazorpayInstance();
    const razorpayOrder = await razorpay.orders.fetch(razorpay_order_id);
    const priceInr = razorpayOrder?.notes?.priceInr
      ? parseInt(String(razorpayOrder.notes.priceInr), 10)
      : 0;
    processReferralRewardOnPurchase(user._id, priceInr).catch((err) =>
      console.error('⚠️ [PAYMENT] Referral reward error (non-fatal):', err)
    );
    console.log(`   Payment ID: ${razorpay_payment_id}`);
    console.log(`   Order ID: ${razorpay_order_id}`);

    // Balance integrity check (fire-and-forget)
    verifyUserBalance(user._id).catch(() => {});

    // Emit coins_updated socket event
    try {
      const io = getIO();
      io.to(`user:${user.firebaseUid}`).emit('coins_updated', {
        userId: user._id.toString(),
        coins: user.coins,
      });
      console.log(`📡 [PAYMENT] Emitted coins_updated to ${user.firebaseUid} (${user.coins} coins)`);
    } catch (socketErr) {
      console.error('⚠️ [PAYMENT] Failed to emit coins_updated:', socketErr);
    }

    res.json({
      success: true,
      data: {
        message: 'Payment verified successfully',
        coins: user.coins,
        coinsAdded: coinsToAdd,
        transactionId: transaction.transactionId,
      },
    });
  } catch (error) {
    console.error('❌ [PAYMENT] Verify payment error:', error);
    res.status(500).json({ success: false, error: 'Payment verification failed' });
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
    console.error('❌ [PAYMENT] getWalletPackages error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch wallet packages' });
  }
};
