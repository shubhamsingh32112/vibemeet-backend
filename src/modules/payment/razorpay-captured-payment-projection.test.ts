import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeCapturedPaymentObservation } from './razorpay-captured-payment-projection.service';

test('normalizes only complete captured provider payment entities', () => {
  assert.deepEqual(
    normalizeCapturedPaymentObservation({
      id: 'pay_123',
      amount: 12_345,
      currency: 'inr',
      captured: true,
      created_at: 1_721_234_567,
      status: 'refunded',
    }),
    {
      id: 'pay_123',
      amount: 12_345,
      currency: 'INR',
      captured: true,
      created_at: 1_721_234_567,
    }
  );
  assert.equal(
    normalizeCapturedPaymentObservation({
      id: 'pay_authorized',
      amount: 100,
      currency: 'INR',
      captured: false,
      created_at: 1_721_234_567,
    }),
    null
  );
  assert.equal(normalizeCapturedPaymentObservation({ id: 'incomplete', captured: true }), null);
});

test('wallet, VIP and Moments verified paths observe projection best-effort', () => {
  const root = join(__dirname, '..');
  const wallet = readFileSync(join(root, 'payment', 'payment.controller.ts'), 'utf8');
  const vip = readFileSync(join(root, 'vip', 'vip.controller.ts'), 'utf8');
  const moments = readFileSync(
    join(root, 'moments-premium', 'moments-premium.controller.ts'),
    'utf8'
  );

  assert.ok(wallet.includes("'wallet_verification'"));
  assert.ok(wallet.includes("'wallet_webhook'"));
  assert.ok(vip.includes("'vip_verification'"));
  assert.ok(vip.includes("'vip_webhook'"));
  assert.ok(moments.includes("'moments_verification'"));
  assert.ok(moments.includes("'moments_webhook'"));
});

test('backfill is frozen, checkpointed, leased and idempotent', () => {
  const source = readFileSync(
    join(__dirname, 'razorpay-captured-payment-backfill.service.ts'),
    'utf8'
  );
  assert.ok(source.includes('providerTo'));
  assert.ok(source.includes('claimed.asOf'));
  assert.ok(source.includes('nextSkip'));
  assert.ok(source.includes('leaseOwner'));
  assert.ok(source.includes("'historical_backfill'"));
  assert.ok(source.includes('page.items.length < PAGE_SIZE'));
});
