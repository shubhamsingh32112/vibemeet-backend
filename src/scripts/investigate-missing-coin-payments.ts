/**
 * Read-only investigation for stuck captured wallet payments.
 *
 * Usage:
 *   powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/with-dev-env.ps1 npx tsx src/scripts/investigate-missing-coin-payments.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { getRazorpayInstance } from '../config/razorpay';
import { CoinTransaction } from '../modules/user/coin-transaction.model';
import { User } from '../modules/user/user.model';
import { PaymentWebhookEvent } from '../modules/payment/payment-webhook-event.model';
import { CheckoutContext } from '../modules/checkout/checkout-context.model';

const TARGETS = [
  { paymentId: 'pay_TKBBcgDKmRwVt5', orderId: 'order_TKBBG0FcWK0Tq9', phone: '+917078956219' },
  { paymentId: 'pay_TKArCAl0YjMZC5', orderId: 'order_TKAqSiTcOVvYTk', phone: '+919545780124' },
  { paymentId: 'pay_TKAl8rviE0C2TT', orderId: 'order_TKAkklBd5304oM', phone: '+917287960885' },
];

function phoneVariants(phone: string): string[] {
  const digits = phone.replace(/\D/g, '');
  const last10 = digits.slice(-10);
  return [...new Set([phone, digits, `+${digits}`, `+91${last10}`, last10])];
}

async function main(): Promise<void> {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGO_URI is required');

  await mongoose.connect(mongoUri);
  const razorpay = getRazorpayInstance();

  try {
    const report: unknown[] = [];
    for (const t of TARGETS) {
      const payment = await razorpay.payments.fetch(t.paymentId);
      const order = t.orderId ? await razorpay.orders.fetch(t.orderId) : null;

      const txs = await CoinTransaction.find({
        $or: [
          { paymentGatewayTransactionId: t.paymentId },
          { paymentGatewayOrderId: t.orderId },
          { transactionId: `pay_${t.orderId}` },
          { transactionId: `razorpay_${t.orderId}` },
        ],
      }).lean();

      const webhooks = await PaymentWebhookEvent.find({
        $or: [{ paymentId: t.paymentId }, { orderId: t.orderId }],
      })
        .sort({ createdAt: 1 })
        .lean();

      const checkouts = await CheckoutContext.find({ orderId: t.orderId }).lean();

      const notes = {
        ...(typeof order?.notes === 'object' && order?.notes ? order.notes : {}),
        ...(typeof payment?.notes === 'object' && payment?.notes ? payment.notes : {}),
      } as Record<string, unknown>;

      const userIdNote = notes.userId ? String(notes.userId) : null;
      const firebaseUid = notes.firebaseUid ? String(notes.firebaseUid) : null;

      let userById = null;
      let userByFirebase = null;
      let usersByPhone: unknown[] = [];

      if (userIdNote && mongoose.isValidObjectId(userIdNote)) {
        userById = await User.findById(userIdNote)
          .select('username phone email coins firebaseUid role')
          .lean();
      }
      if (firebaseUid) {
        userByFirebase = await User.findOne({ firebaseUid })
          .select('username phone email coins firebaseUid role')
          .lean();
      }
      usersByPhone = await User.find({ phone: { $in: phoneVariants(t.phone) } })
        .select('username phone email coins firebaseUid role')
        .lean();

      report.push({
        target: t,
        razorpayPayment: {
          id: payment.id,
          status: payment.status,
          captured: payment.captured,
          amount: payment.amount,
          email: payment.email,
          contact: payment.contact,
          order_id: payment.order_id,
          notes: payment.notes,
          created_at: payment.created_at,
        },
        razorpayOrder: order
          ? {
              id: order.id,
              status: order.status,
              amount: order.amount,
              receipt: order.receipt,
              notes: order.notes,
            }
          : null,
        mergedNotes: notes,
        coinTransactions: txs,
        webhooks: webhooks.map((w) => ({
          eventId: w.eventId,
          eventType: w.eventType,
          status: w.status,
          failureReason: w.failureReason,
          attemptCount: w.attemptCount,
          nextRetryAt: w.nextRetryAt,
          createdAt: w.createdAt,
          processedAt: w.processedAt,
        })),
        checkouts,
        userById,
        userByFirebase,
        usersByPhone,
      });
    }

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
