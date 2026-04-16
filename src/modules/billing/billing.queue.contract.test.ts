/**
 * Contract tests for BullMQ billing job helpers (no Redis / queue I/O).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billingCycleJobId } from './billing.queue';

test('billingCycleJobId matches BullMQ jobId used for deduplication', () => {
  assert.equal(billingCycleJobId('call-xyz'), 'billing-cycle:call-xyz');
});
