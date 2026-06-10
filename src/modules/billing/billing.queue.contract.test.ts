/**
 * Contract tests for BullMQ billing job helpers (no Redis / queue I/O).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { billingCycleJobId } from './billing.queue';

test('billingCycleJobId matches BullMQ jobId used for deduplication', () => {
  assert.equal(billingCycleJobId('call-xyz'), 'billing-call-xyz');
  assert.ok(billingCycleJobId('call-xyz').startsWith('billing-'));
  assert.equal(
    billingCycleJobId('call:terminal:abc'),
    'billing-call__terminal__abc'
  );
  assert.ok(!billingCycleJobId('call:terminal:abc').includes(':'));
});

test('BullMQ concurrency fallback defaults to 50 for ECS tuning', () => {
  const src = readFileSync(join(__dirname, 'billing.queue.ts'), 'utf8');
  assert.ok(src.includes("|| '50'"));
  assert.ok(src.includes('return 50'));
});

test('billing cycle jobs persist completion/failure history', () => {
  const src = readFileSync(join(__dirname, 'billing.queue.ts'), 'utf8');
  assert.ok(src.includes('removeOnComplete: 200'));
  assert.ok(src.includes('removeOnFail: 200'));
  assert.ok(src.includes('billing_cycle_exists_healthy'));
  assert.ok(src.includes('billing_cycle_exists_but_stale'));
  assert.ok(src.includes('BILLING_CYCLE_SCHEDULE_GATE_PREFIX'));
  assert.ok(src.includes('bullmq_cycle_enqueue_result'));
  assert.ok(src.includes('buildCycleInstanceJobId'));
});
