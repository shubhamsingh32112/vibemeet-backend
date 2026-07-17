import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RazorpayCollectedError,
  scanRazorpayCollectedPayments,
  type RazorpayPaymentForCollected,
} from './admin-razorpay-collected.service';

const FROM = new Date('2026-07-16T18:30:00.000Z');
const TO = new Date('2026-07-17T18:30:00.000Z');

function payment(
  id: string,
  overrides: Partial<RazorpayPaymentForCollected> = {}
): RazorpayPaymentForCollected {
  return {
    id,
    amount: 10_000,
    currency: 'INR',
    captured: true,
    status: 'captured',
    created_at: Math.floor(FROM.getTime() / 1000) + 60,
    ...overrides,
  };
}

test('sums captured and refunded-captured payments but excludes other states', async () => {
  const result = await scanRazorpayCollectedPayments({
    from: FROM,
    to: TO,
    asOf: TO,
    fetchPage: async () => ({
      items: [
        payment('captured'),
        payment('refunded', { status: 'refunded', amount: 5_050 }),
        payment('authorized', { captured: false, status: 'authorized' }),
        payment('failed', { captured: false, status: 'failed' }),
      ],
    }),
  });

  assert.equal(result.amountSubunits, '15050');
  assert.equal(result.amountMajor, '150.50');
  assert.equal(result.paymentCount, 2);
});

test('enforces exact local half-open boundaries after expanded provider query', async () => {
  let providerParams: Record<string, number> | undefined;
  const result = await scanRazorpayCollectedPayments({
    from: FROM,
    to: TO,
    asOf: TO,
    fetchPage: async (params) => {
      providerParams = params as Record<string, number>;
      return {
        items: [
          payment('before', { created_at: FROM.getTime() / 1000 - 1 }),
          payment('at-from', { created_at: FROM.getTime() / 1000 }),
          payment('before-to', { created_at: TO.getTime() / 1000 - 1 }),
          payment('at-to', { created_at: TO.getTime() / 1000 }),
        ],
      };
    },
  });

  assert.equal(result.paymentCount, 2);
  assert.equal(providerParams?.from, FROM.getTime() / 1000 - 1);
  assert.equal(providerParams?.to, TO.getTime() / 1000 + 1);
});

test('paginates after an exactly full page and deduplicates provider IDs', async () => {
  const calls: number[] = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => payment(`p-${index}`));
  const result = await scanRazorpayCollectedPayments({
    from: FROM,
    to: TO,
    asOf: TO,
    fetchPage: async ({ skip }) => {
      calls.push(skip);
      return skip === 0
        ? { items: firstPage }
        : { items: [payment('p-99'), payment('p-100')] };
    },
  });

  assert.deepEqual(calls, [0, 100]);
  assert.equal(result.paymentCount, 101);
});

test('keeps currencies separate and never produces a mixed-currency total', async () => {
  const result = await scanRazorpayCollectedPayments({
    from: FROM,
    to: TO,
    asOf: TO,
    fetchPage: async () => ({
      items: [
        payment('inr', { amount: Number.MAX_SAFE_INTEGER }),
        payment('usd', { amount: 125, currency: 'usd' }),
      ],
    }),
  });

  assert.equal(result.amountSubunits, null);
  assert.equal(result.currency, null);
  assert.deepEqual(
    result.currencyBuckets.map((bucket) => bucket.currency),
    ['INR', 'USD']
  );
  assert.equal(result.currencyBuckets[0].amountSubunits, String(Number.MAX_SAFE_INTEGER));
});

test('fails closed on malformed pages and safe scan ceilings', async () => {
  await assert.rejects(
    scanRazorpayCollectedPayments({
      asOf: TO,
      fetchPage: async () => ({ items: [{ id: 'bad' }] }),
    }),
    (error: unknown) => error instanceof RazorpayCollectedError && error.code === 'PROVIDER_MALFORMED'
  );

  await assert.rejects(
    scanRazorpayCollectedPayments({
      asOf: TO,
      maxPages: 1,
      fetchPage: async () => ({ items: Array.from({ length: 100 }, (_, index) => payment(String(index))) }),
    }),
    (error: unknown) => error instanceof RazorpayCollectedError && error.code === 'SCAN_LIMIT'
  );
});
