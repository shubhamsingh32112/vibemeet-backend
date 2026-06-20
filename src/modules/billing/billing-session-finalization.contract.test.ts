import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('finalizeCallSession module exports canonical orchestration API', async () => {
  const mod = await import('./billing-session-finalization.service');
  assert.equal(typeof mod.finalizeCallSession, 'function');
  assert.equal(typeof mod.enqueueSettlementRetry, 'function');
  assert.equal(typeof mod.enqueueImmediateSettlementRetry, 'function');
  assert.equal(typeof mod.processSettlementRetryQueue, 'function');
  assert.equal(typeof mod.isCallBillingAlreadySettled, 'function');
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
  assert.ok(src.includes('isCallBillingAlreadySettled(callId)'));
  assert.ok(src.includes("return { status: 'duplicate', callId }"));
  assert.ok(src.includes('enqueueSettlementRetry(params)'));
  assert.ok(src.includes('enqueueImmediateSettlementRetry(params)'));
  assert.ok(src.includes("return { status: 'pending_retry', callId }"));
  assert.ok(src.includes("rejectionReason: 'stale_worker_active_runtime'"));
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
  assert.ok(src.includes("reason: 'recovering_transition_blocked'"));
  assert.ok(src.includes("session.lifecycleState = transitioned.next"));
  assert.ok(src.includes('billing_watchdog_scheduler_chain_missing'));
  assert.ok(src.includes('scheduler_chain_missing_recovered'));
});

test('finalizer writes terminal tombstone and blocks stale worker settle on ACTIVE', () => {
  const src = readFileSync(join(__dirname, 'billing-session-finalization.service.ts'), 'utf8');
  assert.ok(src.includes('callSessionTerminalKey(callId)'));
  assert.ok(src.includes('BILLING_TERMINAL_TOMBSTONE_TTL_SECONDS'));
  assert.ok(src.includes('billing_finalize_rejected_stale_worker'));
  assert.ok(src.includes('billing_runtime_epoch_reject_stale_worker'));
  assert.ok(src.includes('billingInstanceIdsMatch'));
});

test('finalizer convergence path retries and reconstructs from checkpoint before dead-letter', () => {
  const src = readFileSync(join(__dirname, 'billing-session-finalization.service.ts'), 'utf8');
  assert.ok(src.includes('FINALIZE_CONVERGENCE_MAX_ATTEMPTS'));
  assert.ok(src.includes("billing_finalize_convergence_retry_total"));
  assert.ok(src.includes('billing_lifecycle_checkpoint_reconstructed_from_checkpoint'));
  assert.ok(src.includes('billing_finalize_convergence_deferred_runtime_missing'));
});

test('post-settlement cleanup detects residual runtime keys', () => {
  const src = readFileSync(join(__dirname, 'billing-session-finalization.service.ts'), 'utf8');
  assert.ok(src.includes('billing_finalize_residual_runtime_after_cleanup'));
  assert.ok(src.includes("await redis.del(callSessionKey(callId)).catch(() => 0)"));
});

test('duplicate finalize paths invoke terminal billing teardown', () => {
  const src = readFileSync(join(__dirname, 'billing-session-finalization.service.ts'), 'utf8');
  assert.ok(src.includes('ensureTerminalBillingTeardown'));
  assert.ok(src.includes('await ensureTerminalBillingTeardown(callId)'));
});

test('settlement retry queue forwards attempt and enqueuedAt to finalizeCallSession', () => {
  const src = readFileSync(join(__dirname, 'billing-session-finalization.service.ts'), 'utf8');
  assert.ok(src.includes('retryParamsFromFinalize(parsed)'));
  assert.ok(src.includes('attempt?: number'));
  assert.ok(src.includes('enqueuedAt?: number'));
});

test('dead-letter path clears billing redis keys and creator active call slot', () => {
  const src = readFileSync(join(__dirname, 'billing-session-finalization.service.ts'), 'utf8');
  assert.ok(src.includes('clearCreatorActiveCallSlotIfStale'));
  assert.ok(src.includes("source: 'billing.dead_letter'"));
  assert.ok(src.includes('getDurableCallSession'));
});

test('fast retry worker pauses on backpressure stage 3', () => {
  const src = readFileSync(join(__dirname, 'billing-settlement-retry.worker.ts'), 'utf8');
  assert.ok(src.includes('getBillingBackpressureStage'));
  assert.ok(src.includes('billing_settlement_fast_retry_paused_backpressure'));
});

test('admission hysteresis decouples block from single severe sample', () => {
  const src = readFileSync(join(__dirname, 'billing-backpressure.ts'), 'utf8');
  assert.ok(src.includes('consecutiveSevereSamples'));
  assert.ok(src.includes('getAdmissionBlockSevereSamples'));
  assert.ok(src.includes('billing_admission_hysteresis'));
});

test('handleDurableClaimLost and failed settlement recovery exported paths', () => {
  const src = readFileSync(join(__dirname, 'billing-session-finalization.service.ts'), 'utf8');
  assert.ok(src.includes('async function handleDurableClaimLost'));
  assert.ok(src.includes('export async function attemptFailedSettlementRecovery'));
});
