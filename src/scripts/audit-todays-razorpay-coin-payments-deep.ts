/**
 * CLI wrapper around payment error check (same logic as Finance → Payment error check).
 *
 * Usage:
 *   powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/with-dev-env.ps1 npx tsx src/scripts/audit-todays-razorpay-coin-payments-deep.ts
 *   powershell ... --days=2
 *   powershell ... --from=2026-07-28T00:00:00.000Z --to=2026-07-29T00:00:00.000Z
 */
import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { runPaymentErrorCheck } from '../modules/admin/admin-payment-error-check.service';
import { addIstDays, istDateKey, istDayBounds } from '../utils/ist-time';

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

async function main(): Promise<void> {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGO_URI is required');

  const fromArg = readArg('from');
  const toArg = readArg('to');
  let from: Date;
  let to: Date;

  if (fromArg && toArg) {
    from = new Date(fromArg);
    to = new Date(toArg);
  } else {
    const days = Math.max(1, Number(readArg('days') || '1'));
    const endKey = readArg('date') || istDateKey(new Date());
    const startKey = addIstDays(endKey, -(days - 1));
    from = istDayBounds(startKey).start;
    to = istDayBounds(endKey).end;
  }

  await mongoose.connect(mongoUri);
  try {
    const result = await runPaymentErrorCheck({ from, to });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
