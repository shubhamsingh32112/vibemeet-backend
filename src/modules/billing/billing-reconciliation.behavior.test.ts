import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldFinalizeSessionNoHistory, shouldRescheduleBillingCycleForSession } from './billing-reconciliation.guards';

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

