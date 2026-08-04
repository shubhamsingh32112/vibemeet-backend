/**
 * Reconcile specific captured Razorpay wallet payments (ensure pending + finalize).
 *
 * Usage:
 *   powershell ... npx tsx src/scripts/reconcile-captured-wallet-payments.ts
 *   powershell ... -- --paymentId=pay_xxx --orderId=order_yyy
 */
import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { reconcileCapturedWalletPayment } from '../modules/payment/wallet-payment-reconcile.service';

const DEFAULT_TARGETS = [
  { paymentId: 'pay_TKBBcgDKmRwVt5', orderId: 'order_TKBBG0FcWK0Tq9' },
  { paymentId: 'pay_TKArCAl0YjMZC5', orderId: 'order_TKAqSiTcOVvYTk' },
  { paymentId: 'pay_TKAl8rviE0C2TT', orderId: 'order_TKAkklBd5304oM' },
];

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

async function main(): Promise<void> {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGO_URI is required');

  const paymentId = readArg('paymentId');
  const orderId = readArg('orderId');
  const targets =
    paymentId && orderId ? [{ paymentId, orderId }] : DEFAULT_TARGETS;

  await mongoose.connect(mongoUri);
  try {
    const results = [];
    for (const t of targets) {
      const result = await reconcileCapturedWalletPayment({
        ...t,
        source: 'cli',
      });
      results.push(result);
    }
    console.log(JSON.stringify({ results }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
