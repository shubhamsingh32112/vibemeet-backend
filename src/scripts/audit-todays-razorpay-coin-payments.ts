/**
 * Read-only audit: today's Razorpay captured payments vs coin credits.
 *
 * Usage (from backend/):
 *   powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/with-dev-env.ps1 npx tsx src/scripts/audit-todays-razorpay-coin-payments.ts
 *   powershell ... -- --date=2026-07-29
 */
import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { getRazorpayInstance } from '../config/razorpay';
import { CoinTransaction } from '../modules/user/coin-transaction.model';
import { User } from '../modules/user/user.model';
import { istDateKey, istDayBounds } from '../utils/ist-time';

type RazorpayNotes = Record<string, string | number | boolean | null | undefined>;

type PaymentRow = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  captured: boolean;
  order_id?: string;
  email?: string;
  contact?: string;
  created_at: number;
  notes?: RazorpayNotes;
  method?: string;
};

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

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

function classifyProduct(notes: RazorpayNotes, receipt?: string): 'wallet' | 'vip' | 'moments_premium' | 'unknown' {
  const productType = noteStr(notes, 'productType');
  if (productType === 'vip_membership') return 'vip';
  if (productType === 'moments_premium_membership') return 'moments_premium';
  if (noteStr(notes, 'coins') || noteStr(notes, 'packageId')) return 'wallet';
  if (receipt?.startsWith('web_c_') || receipt?.startsWith('coins_')) return 'wallet';
  if (receipt?.startsWith('vip_')) return 'vip';
  if (receipt?.startsWith('moments_premium_')) return 'moments_premium';
  return 'unknown';
}

async function fetchPaymentsForRange(fromUnix: number, toUnix: number): Promise<PaymentRow[]> {
  const razorpay = getRazorpayInstance();
  const out: PaymentRow[] = [];
  const pageSize = 100;
  for (let skip = 0; ; skip += pageSize) {
    const page = (await razorpay.payments.all({
      from: fromUnix,
      to: toUnix,
      count: pageSize,
      skip,
    })) as { items?: PaymentRow[]; count?: number };

    const items = Array.isArray(page.items) ? page.items : [];
    out.push(...items);
    if (items.length < pageSize) break;
  }
  return out;
}

async function enrichFromOrder(payment: PaymentRow): Promise<{ notes: RazorpayNotes; receipt?: string }> {
  let notes = asNotes(payment.notes);
  let receipt: string | undefined;
  if (!payment.order_id) return { notes, receipt };

  const razorpay = getRazorpayInstance();
  try {
    const order = (await razorpay.orders.fetch(payment.order_id)) as {
      notes?: unknown;
      receipt?: string;
    };
    const orderNotes = asNotes(order.notes);
    notes = { ...orderNotes, ...notes };
    receipt = typeof order.receipt === 'string' ? order.receipt : undefined;
  } catch (error) {
    console.warn(`Failed to fetch order ${payment.order_id}:`, error instanceof Error ? error.message : error);
  }
  return { notes, receipt };
}

async function main(): Promise<void> {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGO_URI is required');

  const dateKey = readArg('date') || istDateKey(new Date());
  const { start, end } = istDayBounds(dateKey);
  const fromUnix = Math.floor(start.getTime() / 1000);
  const toUnix = Math.floor((end.getTime() - 1) / 1000);

  console.log(`Auditing IST day ${dateKey}`);
  console.log(`Range UTC: ${start.toISOString()} → ${end.toISOString()}`);

  await mongoose.connect(mongoUri);
  try {
    console.log(`RAZORPAY_KEY_ID prefix: ${(process.env.RAZORPAY_KEY_ID || '').slice(0, 12)}`);

    const payments = await fetchPaymentsForRange(fromUnix, toUnix);
    const captured = payments.filter(
      (p) => p.captured === true || p.status === 'captured' || p.status === 'authorized',
    );

    console.log(`Razorpay payments in range: ${payments.length} (captured/authorized: ${captured.length})`);
    console.log(
      'All Razorpay payments today:',
      JSON.stringify(
        payments.map((p) => ({
          id: p.id,
          amount: p.amount,
          status: p.status,
          captured: p.captured,
          order_id: p.order_id,
          contact: p.contact,
          email: p.email,
          method: p.method,
          createdAtIso: new Date(p.created_at * 1000).toISOString(),
          notes: p.notes,
        })),
        null,
        2,
      ),
    );

    const mongoTxs = await CoinTransaction.find({
      source: { $in: ['payment_gateway', 'recharge_bonus'] },
      createdAt: { $gte: start, $lt: end },
    })
      .sort({ createdAt: 1 })
      .lean();
    console.log(`\nMongo payment_gateway/recharge_bonus txs today: ${mongoTxs.length}`);
    for (const t of mongoTxs) {
      const u = await User.findById(t.userId)
        .select('username displayName phone email coins firebaseUid')
        .lean();
      console.log(
        JSON.stringify(
          {
            transactionId: t.transactionId,
            status: t.status,
            source: t.source,
            coins: t.coins,
            priceInr: t.priceInr,
            orderId: t.paymentGatewayOrderId,
            paymentId: t.paymentGatewayTransactionId,
            createdAt: t.createdAt,
            user: u
              ? {
                  id: String(u._id),
                  username: u.username,
                  displayName: u.displayName,
                  phone: u.phone,
                  email: u.email,
                  coins: u.coins,
                  firebaseUid: u.firebaseUid,
                }
              : null,
          },
          null,
          2,
        ),
      );
    }

    const walletRows: Array<Record<string, unknown>> = [];
    const otherCaptured: Array<Record<string, unknown>> = [];

    // Include every payment today (not only captured) so authorized/failed still show up.
    const paymentsToAudit = payments.length > 0 ? payments : captured;
    for (const payment of paymentsToAudit) {
      const { notes, receipt } = await enrichFromOrder(payment);
      const product = classifyProduct(notes, receipt);
      const orderId = payment.order_id || noteStr(notes, 'orderId');
      const userId = noteStr(notes, 'userId');
      const firebaseUid = noteStr(notes, 'firebaseUid');
      const coins = noteStr(notes, 'coins');
      const priceInr = noteStr(notes, 'priceInr');
      const amountInr = (payment.amount / 100).toFixed(2);
      const createdAtIso = new Date(payment.created_at * 1000).toISOString();

      if (product !== 'wallet') {
        otherCaptured.push({
          paymentId: payment.id,
          orderId,
          product,
          amountInr,
          status: payment.status,
          createdAtIso,
          userId,
          contact: payment.contact,
          email: payment.email,
        });
        continue;
      }

      const txQuery: Record<string, unknown>[] = [{ paymentGatewayTransactionId: payment.id }];
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

      const mainTx =
        txs.find((t) => t.source === 'payment_gateway') ||
        txs[0] ||
        null;
      const bonusTx = txs.find((t) => t.source === 'recharge_bonus') || null;

      let user: {
        _id: mongoose.Types.ObjectId;
        username?: string;
        displayName?: string;
        phone?: string;
        email?: string;
        coins?: number;
        firebaseUid?: string;
      } | null = null;

      const lookupId = userId || (mainTx ? String(mainTx.userId) : undefined);
      if (lookupId && mongoose.isValidObjectId(lookupId)) {
        user = await User.findById(lookupId)
          .select('username displayName phone email coins firebaseUid')
          .lean();
      } else if (firebaseUid) {
        user = await User.findOne({ firebaseUid })
          .select('username displayName phone email coins firebaseUid')
          .lean();
      }

      const coinsCredited =
        mainTx?.status === 'completed'
          ? (mainTx.coins || 0) + (bonusTx?.status === 'completed' ? bonusTx.coins || 0 : 0)
          : 0;

      const razorpayPaid =
        payment.captured === true ||
        payment.status === 'captured' ||
        payment.status === 'authorized';

      let issue: string;
      if (!razorpayPaid) {
        issue = `RAZORPAY_NOT_PAID_${String(payment.status || 'unknown').toUpperCase()}`;
      } else if (!mainTx) {
        issue = 'NO_COIN_TRANSACTION';
      } else if (mainTx.status === 'pending') {
        issue = 'PAID_BUT_PENDING_CREDIT';
      } else if (mainTx.status === 'failed') {
        issue = 'PAID_BUT_FAILED_CREDIT';
      } else {
        issue = 'OK_CREDITED';
      }

      walletRows.push({
        issue,
        razorpayStatus: payment.status,
        razorpayCaptured: payment.captured,
        paymentId: payment.id,
        orderId: orderId || null,
        amountInr,
        method: payment.method || null,
        razorpayContact: payment.contact || null,
        razorpayEmail: payment.email || null,
        createdAtIso,
        notesCoins: coins || null,
        notesPriceInr: priceInr || null,
        packageId: noteStr(notes, 'packageId') || null,
        userId: user?._id?.toString() || userId || null,
        firebaseUid: user?.firebaseUid || firebaseUid || null,
        username: user?.username || null,
        displayName: user?.displayName || null,
        phone: user?.phone || null,
        email: user?.email || null,
        currentWalletCoins: user?.coins ?? null,
        txStatus: mainTx?.status || null,
        txCoins: mainTx?.coins ?? null,
        txId: mainTx?.transactionId || null,
        bonusStatus: bonusTx?.status || null,
        bonusCoins: bonusTx?.coins ?? null,
        coinsCredited,
      });
    }

    const missing = walletRows.filter((r) => r.issue !== 'OK_CREDITED' && !String(r.issue).startsWith('RAZORPAY_NOT_PAID'));
    const ok = walletRows.filter((r) => r.issue === 'OK_CREDITED');

    console.log('\n=== WALLET COIN PURCHASES (today) ===');
    console.log(JSON.stringify(walletRows, null, 2));

    console.log('\n=== SUMMARY ===');
    console.log(
      JSON.stringify(
        {
          dateIst: dateKey,
          razorpayPaymentsTotal: payments.length,
          capturedOrAuthorized: captured.length,
          walletPayments: walletRows.length,
          creditedOk: ok.length,
          paidButMissingOrPendingCredit: missing.length,
          missingPayments: missing,
          otherCapturedProducts: otherCaptured,
        },
        null,
        2,
      ),
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
