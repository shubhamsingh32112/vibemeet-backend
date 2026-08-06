import mongoose from 'mongoose';
import { getRazorpayInstance } from '../../config/razorpay';
import { featureFlags } from '../../config/feature-flags';
import { logInfo, logWarning } from '../../utils/logger';
import { recordPaymentMetric } from '../../utils/monitoring';
import { User } from '../user/user.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { CheckoutContext } from '../checkout/checkout-context.model';
import {
  createPendingBonusCoinTransaction,
  finalizePaymentAtomically,
  type FinalizePaymentResult,
} from './payment-finalization.service';

type RazorpayNotes = Record<string, string | number | boolean | null | undefined>;

export type WalletReconcileSource = 'webhook' | 'verify' | 'sweep' | 'cli';

export type WalletReconcileOutcome =
  | 'credited'
  | 'already_completed'
  | 'skipped'
  | 'failed';

export type WalletReconcileResult = {
  outcome: WalletReconcileOutcome;
  reason?: string;
  orderId: string;
  paymentId: string;
  userId?: string;
  coinsAdded?: number;
  updatedUserCoins?: number;
  finalizeStatus?: FinalizePaymentResult['status'];
};

function asNotes(raw: unknown): RazorpayNotes {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as RazorpayNotes;
}

function noteStr(notes: RazorpayNotes, key: string): string | undefined {
  const v = notes[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

export function isWalletProductNotes(notes: RazorpayNotes, receipt?: string): boolean {
  const productType = noteStr(notes, 'productType');
  if (productType === 'vip_membership' || productType === 'moments_premium_membership') {
    return false;
  }
  if (noteStr(notes, 'coins') || noteStr(notes, 'packageId')) return true;
  if (receipt?.startsWith('web_c_') || receipt?.startsWith('coins_')) return true;
  return false;
}

function phoneVariants(phone: string): string[] {
  const digits = phone.replace(/\D/g, '');
  const last10 = digits.slice(-10);
  const out = [phone, digits, `+${digits}`, last10];
  if (last10.length === 10) out.push(`+91${last10}`, `91${last10}`);
  return [...new Set(out.filter(Boolean))];
}

const buildPendingTransactionId = (orderId: string) => `pay_${orderId}`;

const getOrderTransactionSelectors = (orderId: string) => [
  { transactionId: buildPendingTransactionId(orderId) },
  { transactionId: `razorpay_${orderId}` },
  { paymentGatewayOrderId: orderId },
];

async function fetchCapturedPaymentAndOrder(
  orderId: string,
  paymentId: string,
): Promise<{ payment: any; order: any }> {
  if (featureFlags.mockPaymentProvider) {
    return {
      payment: { id: paymentId, order_id: orderId, status: 'captured', notes: {} },
      order: { id: orderId, status: 'paid', notes: {}, amount: 0 },
    };
  }

  const razorpay = getRazorpayInstance();
  const payment = await razorpay.payments.fetch(paymentId);
  if (!payment || payment.order_id !== orderId) {
    throw new Error('PAYMENT_ORDER_MISMATCH');
  }
  if (payment.status !== 'captured') {
    throw new Error(`PAYMENT_NOT_CAPTURED:${payment.status || 'unknown'}`);
  }
  const order = await razorpay.orders.fetch(orderId);
  return { payment, order };
}

export async function ensurePendingCoinTransaction(input: {
  userId: string;
  orderId: string;
  coins: number;
  priceInr: number;
}): Promise<'created' | 'exists'> {
  const transactionId = buildPendingTransactionId(input.orderId);
  const existing = await CoinTransaction.findOne({
    $or: getOrderTransactionSelectors(input.orderId),
  });
  if (existing) return 'exists';

  try {
    await CoinTransaction.create({
      transactionId,
      userId: input.userId,
      type: 'credit',
      coins: input.coins,
      source: 'payment_gateway',
      description: `Purchase ${input.coins} coins for ₹${input.priceInr}`,
      priceInr: input.priceInr,
      paymentGatewayTransactionId: input.orderId,
      paymentGatewayOrderId: input.orderId,
      paymentGatewayProvider: 'razorpay',
      status: 'pending',
    });
    return 'created';
  } catch (error: any) {
    if (error?.code === 11000) return 'exists';
    throw error;
  }
}

async function resolveWalletUser(input: {
  notes: RazorpayNotes;
  paymentContact?: string;
  paymentEmail?: string;
}): Promise<{ user: InstanceType<typeof User> | null; via: string | null }> {
  const userIdNote = noteStr(input.notes, 'userId');
  const firebaseUid = noteStr(input.notes, 'firebaseUid');

  if (userIdNote && mongoose.isValidObjectId(userIdNote)) {
    const user = await User.findById(userIdNote);
    if (user) return { user, via: 'notes.userId' };
  }
  if (firebaseUid) {
    const user = await User.findOne({ firebaseUid });
    if (user) return { user, via: 'notes.firebaseUid' };
  }
  if (input.paymentContact) {
    const users = await User.find({ phone: { $in: phoneVariants(input.paymentContact) } }).limit(2);
    if (users.length === 1) return { user: users[0], via: 'payment.contact' };
  }
  if (input.paymentEmail && !input.paymentEmail.toLowerCase().includes('void@razorpay')) {
    const users = await User.find({ email: input.paymentEmail.trim().toLowerCase() }).limit(2);
    if (users.length === 1) return { user: users[0], via: 'payment.email' };
  }
  return { user: null, via: null };
}

/**
 * Idempotent: ensure pending ledger exists from Razorpay order notes, then finalize.
 * Safe to call from webhook, verify, sweep, or CLI.
 */
export async function reconcileCapturedWalletPayment(input: {
  orderId: string;
  paymentId: string;
  source: WalletReconcileSource;
  /** When verify already authenticated a user, require that match. */
  expectedUserId?: string;
}): Promise<WalletReconcileResult> {
  const { orderId, paymentId, source, expectedUserId } = input;
  const base = { orderId, paymentId };

  try {
    const { payment, order } = await fetchCapturedPaymentAndOrder(orderId, paymentId);
    const notes = { ...asNotes(order?.notes), ...asNotes(payment?.notes) };
    const receipt = typeof order?.receipt === 'string' ? order.receipt : undefined;

    if (!isWalletProductNotes(notes, receipt)) {
      recordPaymentMetric('reconcile.skipped', 1, { source, reason: 'not_wallet_product' });
      return { ...base, outcome: 'skipped', reason: 'not_wallet_product' };
    }

    const coinsRaw = noteStr(notes, 'coins');
    const coins = coinsRaw ? Number(coinsRaw) : NaN;
    const priceRaw = noteStr(notes, 'priceInr');
    const priceInr = priceRaw
      ? Number(priceRaw)
      : typeof order?.amount === 'number'
        ? order.amount / 100
        : NaN;

    if (!Number.isFinite(coins) || coins <= 0) {
      recordPaymentMetric('reconcile.skipped', 1, { source, reason: 'notes_missing_coins' });
      return { ...base, outcome: 'skipped', reason: 'notes_missing_coins' };
    }
    if (!Number.isFinite(priceInr) || priceInr <= 0) {
      recordPaymentMetric('reconcile.skipped', 1, { source, reason: 'notes_missing_price' });
      return { ...base, outcome: 'skipped', reason: 'notes_missing_price' };
    }
    if (typeof order?.amount === 'number' && Math.round(priceInr * 100) !== order.amount) {
      logWarning('Wallet reconcile price/amount mismatch', {
        orderId,
        paymentId,
        priceInr,
        orderAmount: order.amount,
        source,
      });
      recordPaymentMetric('reconcile.skipped', 1, { source, reason: 'amount_mismatch' });
      return { ...base, outcome: 'skipped', reason: 'amount_mismatch' };
    }

    const existingTx = await CoinTransaction.findOne({
      $or: [
        { paymentGatewayTransactionId: paymentId },
        ...getOrderTransactionSelectors(orderId),
      ],
      source: { $in: ['payment_gateway', 'recharge_bonus'] },
    }).sort({ createdAt: 1 });

    const mainExisting =
      existingTx && existingTx.source === 'payment_gateway'
        ? existingTx
        : existingTx
          ? await CoinTransaction.findOne({
              $or: getOrderTransactionSelectors(orderId),
              source: 'payment_gateway',
            })
          : null;

    if (mainExisting?.status === 'completed') {
      recordPaymentMetric('reconcile.skipped', 1, { source, reason: 'already_completed' });
      return {
        ...base,
        outcome: 'already_completed',
        reason: 'already_completed',
        userId: mainExisting.userId.toString(),
      };
    }

    const { user, via } = await resolveWalletUser({
      notes,
      paymentContact: typeof payment?.contact === 'string' ? payment.contact : undefined,
      paymentEmail: typeof payment?.email === 'string' ? payment.email : undefined,
    });

    if (!user) {
      const creditedCheckout = await CheckoutContext.findOne({
        orderId,
        status: 'success',
      }).lean();
      const reason = creditedCheckout ? 'user_deleted_after_credit' : 'user_not_found';
      recordPaymentMetric('reconcile.skipped', 1, { source, reason });
      logWarning('Wallet reconcile skipped — user missing', {
        orderId,
        paymentId,
        source,
        reason,
        notesUserId: noteStr(notes, 'userId'),
      });
      return { ...base, outcome: 'skipped', reason };
    }

    if (expectedUserId && user._id.toString() !== expectedUserId) {
      recordPaymentMetric('reconcile.failed', 1, { source, reason: 'user_mismatch' });
      return { ...base, outcome: 'failed', reason: 'TRANSACTION_USER_MISMATCH', userId: user._id.toString() };
    }

    const pendingState = await ensurePendingCoinTransaction({
      userId: user._id.toString(),
      orderId,
      coins,
      priceInr,
    });

    const bonusCoinsRaw = noteStr(notes, 'bonusCoins');
    const bonusCoins = bonusCoinsRaw ? Number(bonusCoinsRaw) : 0;
    if (Number.isFinite(bonusCoins) && bonusCoins > 0) {
      await createPendingBonusCoinTransaction(
        user._id.toString(),
        orderId,
        bonusCoins,
        noteStr(notes, 'bonusReason') || 'VIP',
      );
    }

    const finalizeResult = await finalizePaymentAtomically({
      orderId,
      paymentId,
      expectedUserId: user._id.toString(),
    });

    recordPaymentMetric(
      finalizeResult.status === 'completed' ? 'reconcile.credited' : 'reconcile.already_completed',
      1,
      { source, pending: pendingState },
    );
    logInfo('Wallet payment reconciled', {
      orderId,
      paymentId,
      source,
      userId: user._id.toString(),
      userResolvedVia: via,
      pendingState,
      finalizeStatus: finalizeResult.status,
      coinsAdded: finalizeResult.coinsAdded,
    });

    return {
      ...base,
      outcome: finalizeResult.status === 'completed' ? 'credited' : 'already_completed',
      userId: user._id.toString(),
      coinsAdded: finalizeResult.coinsAdded,
      updatedUserCoins: finalizeResult.updatedUserCoins,
      finalizeStatus: finalizeResult.status,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'reconcile_error';
    recordPaymentMetric('reconcile.failed', 1, { source, reason: reason.slice(0, 64) });
    logWarning('Wallet payment reconcile failed', { orderId, paymentId, source, reason });
    return { ...base, outcome: 'failed', reason };
  }
}
