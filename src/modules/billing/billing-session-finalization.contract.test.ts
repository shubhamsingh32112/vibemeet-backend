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

test('forceTerminateCall triggers finalizeCallEnd before Stream mark_ended', () => {
  const src = readFileSync(join(__dirname, 'billing-termination.service.ts'), 'utf8');
  const finalizeIdx = src.indexOf("void finalizeCallEnd(io, callId, 'force_end')");
  const streamIdx = src.indexOf('await markStreamCallEnded');
  assert.ok(finalizeIdx >= 0 && streamIdx >= 0);
  assert.ok(finalizeIdx < streamIdx, 'settlement must not be gated on Stream success');
});

test('call finalizer maps force and deferred sources to settlement sources', () => {
  const src = readFileSync(join(__dirname, '..', 'video', 'call-finalization.service.ts'), 'utf8');
  assert.ok(src.includes("source === 'force_end'"));
  assert.ok(src.includes("source === 'deferred_pending_end'"));
});

test('bullmq worker uses finalizeCallSession on stop_needs_settlement', () => {
  const src = readFileSync(join(__dirname, 'billing.queue.ts'), 'utf8');
  assert.ok(src.includes("result === 'stop_needs_settlement'"));
  assert.ok(src.includes('finalizeCallSession'));
  assert.ok(!src.includes("from './billing-settlement.service'"));
});

test('finalizer keeps duplicate suppression and retry safeguards', () => {
  const src = readFileSync(join(__dirname, 'billing-session-finalization.service.ts'), 'utf8');
  assert.ok(src.includes('isAlreadySettled(callId)'));
  assert.ok(src.includes("return { status: 'duplicate', callId }"));
  assert.ok(src.includes('enqueueSettlementRetry(params)'));
  assert.ok(src.includes('settlementClaimKey(callId)'));
  assert.ok(src.includes('RELEASE_IF_MATCH_LUA'));
  assert.ok(src.includes('finalizeInflightKey(callId)'));
  assert.ok(src.includes('moveCallToRecoveryDeadLetter'));
});

test('finalizer keeps ordering: remove scheduling before persistence', () => {
  const src = readFileSync(join(__dirname, 'billing-session-finalization.service.ts'), 'utf8');
  const removeIdx = src.indexOf('await removeCallFromBilling(callId);');
  const settleIdx = src.indexOf('const persistResult = await settleCall');
  assert.ok(removeIdx >= 0 && settleIdx >= 0);
  assert.ok(removeIdx < settleIdx, 'call must be unscheduled before persistence');
});

test('finalizer checkpoints SETTLED before billing:settled emit', () => {
  const src = readFileSync(join(__dirname, 'billing-session-finalization.service.ts'), 'utf8');
  const checkpointIdx = src.indexOf("await checkpointLifecycleState(callId, 'SETTLED', 'settled');");
  const emitIdx = src.indexOf('emitBillingSettledFromSnapshot(');
  assert.ok(checkpointIdx >= 0 && emitIdx >= 0);
  assert.ok(checkpointIdx < emitIdx, 'checkpoint must persist before settled emit');
});

test('watchdog recovery path includes cooldown and attempt cap guards', () => {
  const src = readFileSync(join(__dirname, 'billing-watchdog.service.ts'), 'utf8');
  assert.ok(src.includes('WATCHDOG_ATTEMPT_CAP'));
  assert.ok(src.includes('billingWatchdogCooldownKey(callId)'));
  assert.ok(src.includes('moveCallToRecoveryDeadLetter'));
});

test('finalizer writes terminal tombstone and blocks stale worker settle on ACTIVE', () => {
  const src = readFileSync(join(__dirname, 'billing-session-finalization.service.ts'), 'utf8');
  assert.ok(src.includes('callSessionTerminalKey(callId)'));
  assert.ok(src.includes('BILLING_TERMINAL_TOMBSTONE_TTL_SECONDS'));
  assert.ok(src.includes('billing_finalize_rejected_stale_worker'));
  assert.ok(src.includes('billing_runtime_epoch_reject_stale_worker'));
});
