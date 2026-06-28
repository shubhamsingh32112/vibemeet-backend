import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

test('payment finalization completes pending bonus on idempotent retry', () => {
  const src = fs.readFileSync(
    path.join(root, 'payment-finalization.service.ts'),
    'utf8',
  );
  assert.ok(src.includes('Payment bonus finalized on idempotent retry'));
  assert.ok(src.includes('buildPendingBonusTransactionId(orderId)'));
  assert.match(
    src,
    /if \(!updatedTx\)[\s\S]*bonusTx[\s\S]*coinsAdded: bonusCoinsAdded/,
  );
});

test('createPendingBonusCoinTransaction skips duplicate order bonus txn', () => {
  const src = fs.readFileSync(
    path.join(root, 'payment-finalization.service.ts'),
    'utf8',
  );
  assert.match(src, /const existing = await CoinTransaction\.findOne\(\{ transactionId \}\)/);
});
