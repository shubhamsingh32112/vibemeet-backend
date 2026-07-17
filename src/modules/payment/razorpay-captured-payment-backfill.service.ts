import { randomUUID } from 'crypto';
import {
  fetchRazorpayPaymentsPage,
  parseRazorpayPaymentPage,
  razorpayModeName,
} from '../admin/admin-razorpay-collected.service';
import { RazorpayProjectionBackfill } from './razorpay-projection-backfill.model';
import { upsertCapturedPaymentObservation } from './razorpay-captured-payment-projection.service';

const PAGE_SIZE = 100;
const LEASE_MS = 60_000;

export type RazorpayBackfillResult = {
  status: 'complete';
  alreadyComplete: boolean;
  asOf: string;
  pagesProcessed: number;
  paymentsObserved: number;
};

export async function runRazorpayCapturedPaymentBackfill(): Promise<RazorpayBackfillResult> {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required');
  }
  const mode = razorpayModeName();
  const now = new Date();
  await RazorpayProjectionBackfill.updateOne(
    { mode },
    {
      $setOnInsert: {
        mode,
        status: 'pending',
        asOf: now,
        nextSkip: 0,
        pagesProcessed: 0,
        paymentsObserved: 0,
        startedAt: now,
      },
    },
    { upsert: true }
  );

  const existing = await RazorpayProjectionBackfill.findOne({ mode }).lean();
  if (existing?.status === 'complete') {
    return {
      status: 'complete',
      alreadyComplete: true,
      asOf: existing.asOf.toISOString(),
      pagesProcessed: existing.pagesProcessed,
      paymentsObserved: existing.paymentsObserved,
    };
  }

  const owner = `${process.pid}:${randomUUID()}`;
  const claimed = await RazorpayProjectionBackfill.findOneAndUpdate(
    {
      mode,
      status: { $ne: 'complete' },
      $or: [
        { leaseUntil: { $exists: false } },
        { leaseUntil: null },
        { leaseUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        status: 'running',
        leaseOwner: owner,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
      },
      $unset: { lastError: 1 },
    },
    { new: true }
  );
  if (!claimed) throw new Error('Razorpay projection backfill is already running');

  const providerTo = Math.ceil(claimed.asOf.getTime() / 1000) + 1;
  let skip = claimed.nextSkip;
  let pagesProcessed = claimed.pagesProcessed;
  let paymentsObserved = claimed.paymentsObserved;

  try {
    for (;;) {
      const page = parseRazorpayPaymentPage(
        await fetchRazorpayPaymentsPage({ count: PAGE_SIZE, skip, to: providerTo })
      );
      let observedOnPage = 0;
      for (const payment of page.items) {
        if (payment.created_at * 1000 >= claimed.asOf.getTime()) continue;
        if (
          await upsertCapturedPaymentObservation(
            payment,
            'historical_backfill',
            new Date()
          )
        ) {
          observedOnPage += 1;
        }
      }

      skip += PAGE_SIZE;
      pagesProcessed += 1;
      paymentsObserved += observedOnPage;
      const isComplete = page.items.length < PAGE_SIZE;
      const checkpoint = await RazorpayProjectionBackfill.findOneAndUpdate(
        { _id: claimed._id, leaseOwner: owner },
        {
          $set: {
            status: isComplete ? 'complete' : 'running',
            nextSkip: skip,
            pagesProcessed,
            paymentsObserved,
            ...(isComplete
              ? {
                  completedAt: new Date(),
                  leaseOwner: null,
                  leaseUntil: null,
                }
              : { leaseUntil: new Date(Date.now() + LEASE_MS) }),
          },
        },
        { new: true }
      );
      if (!checkpoint) throw new Error('Razorpay projection backfill lease was lost');
      if (isComplete) {
        return {
          status: 'complete',
          alreadyComplete: false,
          asOf: claimed.asOf.toISOString(),
          pagesProcessed,
          paymentsObserved,
        };
      }
    }
  } catch (error) {
    await RazorpayProjectionBackfill.updateOne(
      { _id: claimed._id, leaseOwner: owner },
      {
        $set: {
          status: 'failed',
          lastError: error instanceof Error ? error.message.slice(0, 500) : 'unknown error',
          leaseOwner: null,
          leaseUntil: null,
        },
      }
    );
    throw error;
  }
}
