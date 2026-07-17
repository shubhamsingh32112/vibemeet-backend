import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { runRazorpayCapturedPaymentBackfill } from '../modules/payment/razorpay-captured-payment-backfill.service';

async function main(): Promise<void> {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) throw new Error('MONGO_URI is required');

  await mongoose.connect(mongoUri);
  try {
    const result = await runRazorpayCapturedPaymentBackfill();
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
