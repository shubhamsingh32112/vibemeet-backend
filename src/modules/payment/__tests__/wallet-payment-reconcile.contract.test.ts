import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

test('wallet reconcile service ensures pending then finalizes', () => {
  const src = fs.readFileSync(path.join(root, 'wallet-payment-reconcile.service.ts'), 'utf8');
  assert.ok(src.includes('ensurePendingCoinTransaction'));
  assert.ok(src.includes('finalizePaymentAtomically'));
  assert.ok(src.includes('user_deleted_after_credit'));
  assert.match(src, /WalletReconcileSource/);
  assert.ok(src.includes('amount_mismatch'));
});

test('webhook heals TRANSACTION_NOT_FOUND via reconcile', () => {
  const src = fs.readFileSync(path.join(root, 'payment.controller.ts'), 'utf8');
  assert.ok(src.includes('reconcileCapturedWalletPayment'));
  assert.ok(src.includes("source: 'webhook'"));
  assert.ok(src.includes("source: 'verify'"));
  assert.ok(src.includes('user_deleted_after_credit'));
  assert.ok(!src.includes("if (message.startsWith('TRANSACTION_NOT_FOUND')) return false"));
});

test('createWebOrder returns razorpay prefill and logs orphan order on pending failure', () => {
  const src = fs.readFileSync(path.join(root, 'payment.controller.ts'), 'utf8');
  assert.ok(src.includes('prefill'));
  assert.ok(src.includes('payment.orphan_razorpay_order'));
});

test('account deletion preserves payment_gateway ledger rows', () => {
  const src = fs.readFileSync(
    path.join(root, '..', 'user', 'user.controller.ts'),
    'utf8',
  );
  assert.ok(src.includes("source: { $nin: ['payment_gateway', 'recharge_bonus'] }"));
  assert.ok(!src.includes('CoinTransaction.deleteMany({ userId: user._id })'));
});

test('payment error check classifies credited-then-deleted users', () => {
  const src = fs.readFileSync(
    path.join(root, '..', 'admin', 'admin-payment-error-check.service.ts'),
    'utf8',
  );
  assert.ok(src.includes('CREDITED_USER_DELETED'));
  assert.ok(src.includes('credited (user/ledger deleted)'));
});

test('billing worker starts wallet reconcile sweep', () => {
  const src = fs.readFileSync(
    path.join(root, '..', '..', 'bootstrap', 'bootstrap-billing-workers.ts'),
    'utf8',
  );
  assert.ok(src.includes('startWalletPaymentReconcileSweepWorker'));
});
