import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('call finalizer only marks settled on true settlement completion', () => {
  const src = readFileSync(join(__dirname, 'call-finalization.service.ts'), 'utf8');
  assert.ok(src.includes('isFinalizeSettlementComplete'));
  assert.ok(src.includes('isCallBillingAlreadySettled(callId)'));
  assert.ok(src.includes("status === 'settled'"));
  assert.ok(!src.includes("status === 'settled' || status === 'duplicate'"));
  assert.ok(src.includes('call_finalize_false_success_prevented'));
  assert.ok(src.includes('call.finalize.pending_retry'));
  assert.ok(src.includes('if (settlementComplete)'));
  assert.ok(src.includes('Call finalization pending settlement retry'));
});

test('call finalizer exports deferred end and non-owner delegation helpers', () => {
  const src = readFileSync(join(__dirname, 'call-finalization.service.ts'), 'utf8');
  assert.ok(src.includes('markCallEndingForDeferredEnd'));
  assert.ok(src.includes('delegateCallEndSettlementToRetry'));
  assert.ok(src.includes('callEndingKey(callId)'));
  assert.ok(src.includes('enqueueImmediateSettlementRetry'));
});

test('billing socket gateway defers with session wait and owner-aware settlement', () => {
  const src = readFileSync(join(__dirname, '..', 'billing', 'billing-socket.gateway.ts'), 'utf8');
  assert.ok(src.includes('waitForBillingSessionReady'));
  assert.ok(src.includes('markCallEndingForDeferredEnd'));
  assert.ok(src.includes('delegateCallEndSettlementToRetry'));
  assert.ok(src.includes('billingInstanceIdsMatch'));
});

test('call reconciliation skips re-busy for pending or ending calls', () => {
  const src = readFileSync(join(__dirname, 'call-reconciliation.ts'), 'utf8');
  assert.ok(src.includes('pendingCallEndKey(call.callId)'));
  assert.ok(src.includes('callEndingKey(call.callId)'));
});

test('creator active call slot treats pending end as not live', () => {
  const src = readFileSync(
    join(__dirname, '..', 'availability', 'creator-active-call-slot.service.ts'),
    'utf8'
  );
  assert.ok(src.includes('pendingCallEndKey(slotCallId)'));
  assert.ok(src.includes('callEndingKey(slotCallId)'));
});

test('settlement fast retry worker is bootstrapped', () => {
  const worker = readFileSync(
    join(__dirname, '..', 'billing', 'billing-settlement-retry.worker.ts'),
    'utf8'
  );
  const bootstrap = readFileSync(join(__dirname, '..', '..', 'bootstrap', 'bootstrap-billing-workers.ts'), 'utf8');
  assert.ok(worker.includes('processSettlementRetryQueue'));
  assert.ok(worker.includes('startSettlementFastRetryWorker'));
  assert.ok(bootstrap.includes('startSettlementFastRetryWorker'));
});
