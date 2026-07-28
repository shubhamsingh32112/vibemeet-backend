import mongoose from 'mongoose';
import { getRazorpayInstance, isRazorpayConfigured } from '../../config/razorpay';
import { CoinTransaction } from '../user/coin-transaction.model';
import { User } from '../user/user.model';

export type PaymentErrorCheckRow = {
  username: string | null;
  email: string | null;
  phone: string | null;
  userId: string | null;
  amountInr: number;
  coins: number | null;
  amountLabel: string;
  paymentId: string;
  orderId: string | null;
  razorpayLabel: string;
  mongoTxLabel: string;
  walletNow: number | null;
  whenUtc: string;
  createdAtIso: string;
  issue: 'OK_CREDITED' | 'PAID_BUT_PENDING' | 'PAID_BUT_FAILED' | 'NO_COIN_TRANSACTION';
};

export type PaymentErrorCheckResult = {
  configured: boolean;
  from: string;
  to: string;
  scannedPayments: number;
  capturedWalletPayments: number;
  gotCoins: PaymentErrorCheckRow[];
  paidNoCoins: PaymentErrorCheckRow[];
};

type RazorpayNotes = Record<string, string | number | boolean | null | undefined>;

type PaymentRow = {
  id: string;
  amount: number;
  currency?: string;
  status: string;
  captured: boolean;
  order_id?: string;
  email?: string;
  contact?: string;
  created_at: number;
  notes?: RazorpayNotes;
  method?: string;
};

const PAGE_SIZE = 100;
const MAX_PAGES = Math.max(1, Number(process.env.PAYMENT_ERROR_CHECK_MAX_PAGES ?? 50));
const MAX_RANGE_MS = 7 * 24 * 60 * 60 * 1000;

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

function isWalletProduct(notes: RazorpayNotes, receipt?: string): boolean {
  const productType = noteStr(notes, 'productType');
  if (productType === 'vip_membership' || productType === 'moments_premium_membership') {
    return false;
  }
  if (noteStr(notes, 'coins') || noteStr(notes, 'packageId')) return true;
  if (receipt?.startsWith('web_c_') || receipt?.startsWith('coins_')) return true;
  return false;
}

function formatWhenUtc(createdAtUnix: number): string {
  const d = new Date(createdAtUnix * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function amountLabel(amountInr: number, coins: number | null): string {
  const inr = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amountInr);
  if (coins != null && coins > 0) return `${inr} (${coins} coins)`;
  return inr;
}

async function fetchPaymentsForRange(fromUnix: number, toUnix: number): Promise<PaymentRow[]> {
  const razorpay = getRazorpayInstance();
  const out: PaymentRow[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const skip = page * PAGE_SIZE;
    const pageResult = (await razorpay.payments.all({
      from: fromUnix,
      to: toUnix,
      count: PAGE_SIZE,
      skip,
    })) as { items?: PaymentRow[] };
    const items = Array.isArray(pageResult.items) ? pageResult.items : [];
    out.push(...items);
    if (items.length < PAGE_SIZE) break;
  }
  return out;
}

async function enrichNotesAndReceipt(
  payment: PaymentRow
): Promise<{ notes: RazorpayNotes; receipt?: string; orderStatus?: string }> {
  let notes = asNotes(payment.notes);
  let receipt: string | undefined;
  let orderStatus: string | undefined;
  if (!payment.order_id) return { notes, receipt, orderStatus };

  const razorpay = getRazorpayInstance();
  try {
    const order = (await razorpay.orders.fetch(payment.order_id)) as {
      notes?: unknown;
      receipt?: string;
      status?: string;
    };
    notes = { ...asNotes(order.notes), ...notes };
    receipt = typeof order.receipt === 'string' ? order.receipt : undefined;
    orderStatus = typeof order.status === 'string' ? order.status : undefined;
  } catch {
    // Best-effort enrichment; payment notes alone may be enough.
  }
  return { notes, receipt, orderStatus };
}

export async function runPaymentErrorCheck(input: {
  from: Date;
  to: Date;
}): Promise<PaymentErrorCheckResult> {
  const { from, to } = input;
  if (!(to.getTime() > from.getTime())) {
    throw new Error('INVALID_RANGE');
  }
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
    throw new Error('RANGE_TOO_WIDE');
  }

  if (!isRazorpayConfigured()) {
    return {
      configured: false,
      from: from.toISOString(),
      to: to.toISOString(),
      scannedPayments: 0,
      capturedWalletPayments: 0,
      gotCoins: [],
      paidNoCoins: [],
    };
  }

  const fromUnix = Math.floor(from.getTime() / 1000);
  const toUnix = Math.floor((to.getTime() - 1) / 1000);
  const payments = await fetchPaymentsForRange(fromUnix, toUnix);
  const captured = payments.filter((p) => p.captured === true || p.status === 'captured');

  const gotCoins: PaymentErrorCheckRow[] = [];
  const paidNoCoins: PaymentErrorCheckRow[] = [];

  for (const payment of captured) {
    const { notes, receipt, orderStatus } = await enrichNotesAndReceipt(payment);
    if (!isWalletProduct(notes, receipt)) continue;

    const orderId = payment.order_id || null;
    const userIdNote = noteStr(notes, 'userId');
    const firebaseUid = noteStr(notes, 'firebaseUid');
    const notesCoins = noteStr(notes, 'coins');
    const coinsFromNotes = notesCoins ? Number(notesCoins) : null;
    const amountInr = (payment.amount || 0) / 100;

    const txQuery: Array<Record<string, unknown>> = [
      { paymentGatewayTransactionId: payment.id },
    ];
    if (orderId) {
      txQuery.push({ paymentGatewayOrderId: orderId });
      txQuery.push({ transactionId: `pay_${orderId}` });
      txQuery.push({ transactionId: `razorpay_${orderId}` });
    }

    const txs = await CoinTransaction.find({
      $or: txQuery,
      source: { $in: ['payment_gateway', 'recharge_bonus'] },
    })
      .sort({ createdAt: 1 })
      .lean();

    const mainTx = txs.find((t) => t.source === 'payment_gateway') || txs[0] || null;

    let user: {
      _id: mongoose.Types.ObjectId;
      username?: string;
      phone?: string;
      email?: string;
      coins?: number;
    } | null = null;

    const lookupId = userIdNote || (mainTx ? String(mainTx.userId) : undefined);
    if (lookupId && mongoose.isValidObjectId(lookupId)) {
      user = await User.findById(lookupId).select('username phone email coins').lean();
    } else if (firebaseUid) {
      user = await User.findOne({ firebaseUid }).select('username phone email coins').lean();
    }

    const coins = mainTx?.coins ?? (Number.isFinite(coinsFromNotes) ? coinsFromNotes : null);
    let issue: PaymentErrorCheckRow['issue'];
    let mongoTxLabel: string;
    if (!mainTx) {
      issue = 'NO_COIN_TRANSACTION';
      mongoTxLabel = 'missing';
    } else if (mainTx.status === 'completed') {
      issue = 'OK_CREDITED';
      mongoTxLabel = 'completed';
    } else if (mainTx.status === 'pending') {
      issue = 'PAID_BUT_PENDING';
      mongoTxLabel = 'still pending';
    } else {
      issue = 'PAID_BUT_FAILED';
      mongoTxLabel = String(mainTx.status);
    }

    const razorpayLabel =
      orderStatus === 'paid' ? 'captured (order paid)' : payment.status === 'captured' ? 'captured' : String(payment.status);

    const row: PaymentErrorCheckRow = {
      username: user?.username ?? null,
      email: user?.email ?? payment.email ?? null,
      phone: user?.phone ?? payment.contact ?? null,
      userId: user?._id ? String(user._id) : userIdNote ?? null,
      amountInr,
      coins,
      amountLabel: amountLabel(amountInr, coins),
      paymentId: payment.id,
      orderId,
      razorpayLabel,
      mongoTxLabel,
      walletNow: user?.coins ?? null,
      whenUtc: formatWhenUtc(payment.created_at),
      createdAtIso: new Date(payment.created_at * 1000).toISOString(),
      issue,
    };

    if (issue === 'OK_CREDITED') gotCoins.push(row);
    else paidNoCoins.push(row);
  }

  return {
    configured: true,
    from: from.toISOString(),
    to: to.toISOString(),
    scannedPayments: payments.length,
    capturedWalletPayments: gotCoins.length + paidNoCoins.length,
    gotCoins,
    paidNoCoins,
  };
}
