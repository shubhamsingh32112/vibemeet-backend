import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('finalizeCallSession module exports canonical orchestration API', async () => {
  const mod = await import('./billing-session-finalization.service');
  assert.equal(typeof mod.finalizeCallSession, 'function');
  assert.equal(typeof mod.enqueueSettlementRetry, 'function');
  assert.equal(typeof mod.processSettlementRetryQueue, 'function');
});

test('settleCall legacy path flushes only when not from finalizer', () => {
  const src = readFileSync(join(__dirname, 'billing-settlement.service.ts'), 'utf8');
  assert.ok(src.includes('export async function settleCall'));
  assert.ok(src.includes('_fromFinalizer'));
  assert.ok(src.includes('if (!fromFinalizer)'));
  const flushIdx = src.indexOf('flushBillingToQuiescence');
  const fromFinalizerIdx = src.indexOf('const fromFinalizer');
  assert.ok(flushIdx > fromFinalizerIdx);
});

test('finalizer owns flush orchestration', () => {
  const finalization = readFileSync(
    join(__dirname, 'billing-session-finalization.service.ts'),
    'utf8'
  );
  assert.ok(finalization.includes('flushBillingToQuiescence'));
  assert.ok(finalization.includes('billing_finalize_begin'));
  assert.ok(finalization.includes('BILLING_MAX_SETTLING_MS'));
});

test('forceTerminateCall triggers finalizeCallSession before Stream mark_ended', () => {
  const src = readFileSync(join(__dirname, 'billing-termination.service.ts'), 'utf8');
  const finalizeIdx = src.indexOf('void finalizeCallSession');
  const streamIdx = src.indexOf('await markStreamCallEnded');
  assert.ok(finalizeIdx >= 0 && streamIdx >= 0);
  assert.ok(finalizeIdx < streamIdx, 'settlement must not be gated on Stream success');
});

test('batch processor uses finalizeCallSession on stop_needs_settlement', () => {
  const src = readFileSync(join(__dirname, 'billing-batch.processor.ts'), 'utf8');
  assert.ok(src.includes('finalizeCallSession'));
  assert.ok(!src.includes("from './billing-settlement.service'"));
});
