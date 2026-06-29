import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

test('settleCall includes transaction retry loop and instrumentation', () => {
  const src = readFileSync(
    join(__dirname, 'billing-settlement.service.ts'),
    'utf8'
  );
  assert.ok(src.includes('settlement_transaction_attempt'));
  assert.ok(src.includes('settlement_transaction_stage'));
  assert.ok(src.includes('settlement_transaction_failed'));
  assert.ok(src.includes('SETTLEMENT_TXN_MAX_ATTEMPTS'));
  assert.ok(src.includes('settlement_transaction_commit_ambiguous_resolved'));
  assert.ok(src.includes('throwSettlementTxnError'));
  assert.ok(src.includes('walletDeductedMicros'));
  assert.ok(src.includes('authoritativeTotals.source === \'none\''));
  assert.ok(!src.includes('withTransaction'));
});

test('billing queue claims settlement requested before finalize', () => {
  const queueSrc = readFileSync(join(__dirname, 'billing.queue.ts'), 'utf8');
  assert.ok(queueSrc.includes('tryClaimSettlementRequested'));

  const termSrc = readFileSync(join(__dirname, 'billing-termination.service.ts'), 'utf8');
  assert.ok(termSrc.includes('tryClaimSettlementRequested'));

  const guardsSrc = readFileSync(join(__dirname, 'billing-settlement-trigger.guards.ts'), 'utf8');
  assert.ok(guardsSrc.includes('billingSettlementRequestedKey'));
});

test('billing queue skips duplicate stop_needs_settlement', () => {
  const src = readFileSync(join(__dirname, 'billing.queue.ts'), 'utf8');
  assert.ok(src.includes('tryClaimSettlementRequested'));
});

test('zero settlement guard wired in finalization', () => {
  const src = readFileSync(
    join(__dirname, 'billing-session-finalization.service.ts'),
    'utf8'
  );
  assert.ok(src.includes('shouldBlockZeroSettlement'));
  assert.ok(src.includes('billing_finalize_zero_blocked'));
});

test('admin settlement retry routes exist', () => {
  const routes = readFileSync(join(__dirname, '..', 'admin', 'admin.routes.ts'), 'utf8');
  assert.ok(routes.includes('settlement-retry-preview'));
  assert.ok(routes.includes('retry-settlement'));
});

test('admin calls list uses batch settlement meta', () => {
  const controller = readFileSync(join(__dirname, '..', 'admin', 'admin.controller.ts'), 'utf8');
  assert.ok(controller.includes('batchBuildSettlementListMeta'));
});
