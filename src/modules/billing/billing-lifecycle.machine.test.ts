import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transitionBillingState, type BillingLifecycleState } from './billing-lifecycle.machine';

function run(from: BillingLifecycleState, to: BillingLifecycleState) {
  return transitionBillingState({
    callId: 'test-call',
    from,
    to,
    source: 'test',
    reason: 'unit-test',
  });
}

test('allows expected lifecycle transitions', () => {
  assert.equal(run('INIT', 'STARTING').valid, true);
  assert.equal(run('STARTING', 'ACTIVE').valid, true);
  assert.equal(run('ACTIVE', 'ENDING').valid, true);
  assert.equal(run('ACTIVE', 'RECOVERING').valid, true);
  assert.equal(run('RECOVERING', 'ACTIVE').valid, true);
  assert.equal(run('ENDING', 'SETTLING').valid, true);
  assert.equal(run('SETTLING', 'SETTLED').valid, true);
  assert.equal(run('SETTLING', 'FAILED').valid, true);
});

test('rejects invalid lifecycle transitions', () => {
  assert.equal(run('ACTIVE', 'STARTING').valid, false);
  assert.equal(run('SETTLED', 'ACTIVE').valid, false);
  assert.equal(run('FAILED', 'ACTIVE').valid, false);
  assert.equal(run('SETTLED', 'ENDING').valid, false);
});

test('treats duplicate transitions as idempotent no-op', () => {
  const res = run('ACTIVE', 'ACTIVE');
  assert.equal(res.valid, true);
  assert.equal(res.changed, false);
  assert.equal(res.next, 'ACTIVE');
});

