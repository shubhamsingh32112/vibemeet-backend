import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldFinalizeSessionNoHistory, shouldRescheduleBillingCycleForSession, shouldBlockZeroSettlement } from './billing-reconciliation.guards';

test('behavioral: should not reschedule billing cycle for SETTLED session', () => {
  assert.equal(
    shouldRescheduleBillingCycleForSession({ lifecycleState: 'SETTLED' }, false),
    false
  );
});

test('behavioral: should reschedule billing cycle for ACTIVE session without tombstone', () => {
  assert.equal(
    shouldRescheduleBillingCycleForSession({ lifecycleState: 'ACTIVE' }, false),
    true
  );
});

test('behavioral: should not reschedule billing cycle when settled tombstone present', () => {
  assert.equal(
    shouldRescheduleBillingCycleForSession({ lifecycleState: 'ACTIVE' }, true),
    false
  );
});

test('behavioral: should not finalize live session with deductions but no CallHistory', () => {
  const decision = shouldFinalizeSessionNoHistory(
    {
      totalDeductedMicros: 1000,
      lifecycleState: 'ACTIVE',
      lastProcessedAt: Date.now(),
    },
    Date.now(),
    10 * 60_000
  );
  assert.equal(decision.shouldFinalize, false);
  assert.equal(decision.skipReason, 'live_session_no_history');
});

test('behavioral: should not finalize terminal-but-recent session without CallHistory', () => {
  const now = Date.now();
  const decision = shouldFinalizeSessionNoHistory(
    {
      totalDeductedMicros: 1000,
      lifecycleState: 'FAILED',
      lastProcessedAt: now - 30_000,
    },
    now,
    10 * 60_000
  );
  assert.equal(decision.shouldFinalize, false);
  assert.equal(decision.skipReason, 'terminal_but_recent_no_history');
});

test('behavioral: should finalize terminal and stale session without CallHistory', () => {
  const now = Date.now();
  const decision = shouldFinalizeSessionNoHistory(
    {
      totalDeductedMicros: 1000,
      lifecycleState: 'FAILED',
      lastProcessedAt: now - 20 * 60_000,
    },
    now,
    10 * 60_000
  );
  assert.equal(decision.shouldFinalize, true);
  assert.equal(decision.skipReason, undefined);
});

test('behavioral: shouldBlockZeroSettlement blocks zero deduct with positive sequence', () => {
  const blocked = shouldBlockZeroSettlement({
    totalDeductedMicros: 0,
    totalEarnedMicros: 0,
    billingSequence: 5,
    source: 'durable',
  });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, 'zero_deduct_with_positive_sequence');
});

test('behavioral: shouldBlockZeroSettlement allows non-zero deduct', () => {
  const blocked = shouldBlockZeroSettlement({
    totalDeductedMicros: 27_000_000,
    totalEarnedMicros: 6_000_000,
    billingSequence: 5,
    source: 'redis',
  });
  assert.equal(blocked.blocked, false);
});

test('behavioral: shouldBlockZeroSettlement blocks earn without deduct from authoritative source', () => {
  const blocked = shouldBlockZeroSettlement({
    totalDeductedMicros: 0,
    totalEarnedMicros: 6_000_000,
    billingSequence: 0,
    source: 'redis',
  });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, 'zero_deduct_with_positive_earn');
});
