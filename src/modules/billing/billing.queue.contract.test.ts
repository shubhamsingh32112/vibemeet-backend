/**
 * Contract tests for BullMQ billing job helpers (no Redis / queue I/O).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { billingCycleJobId } from './billing.queue';

test('billingCycleJobId matches BullMQ jobId used for deduplication', () => {
  assert.equal(billingCycleJobId('call-xyz'), 'billing:call-xyz');
  assert.ok(billingCycleJobId('call-xyz').startsWith('billing:'));
});

test('billing cycle jobs persist completion/failure history', () => {
  const src = readFileSync(join(__dirname, 'billing.queue.ts'), 'utf8');
  assert.ok(src.includes('removeOnComplete: false'));
  assert.ok(src.includes('removeOnFail: false'));
  assert.ok(src.includes('billing_cycle_exists_healthy'));
  assert.ok(src.includes('billing_cycle_exists_but_stale'));
});
