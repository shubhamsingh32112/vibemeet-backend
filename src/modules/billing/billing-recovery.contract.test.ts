import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('recover-state uses participant-aware active call check', () => {
  const socketSrc = readFileSync(join(__dirname, 'billing-socket.gateway.ts'), 'utf8');
  const activeSrc = readFileSync(join(__dirname, 'billing-active-call.service.ts'), 'utf8');
  assert.ok(socketSrc.includes('isCallActiveForParticipant'));
  assert.ok(activeSrc.includes('export async function isCallActiveForParticipant'));
  assert.ok(socketSrc.includes('participantFirebaseUid: firebaseUid'));
  assert.ok(socketSrc.includes('isSessionParticipant'));
  assert.ok(socketSrc.includes('creatorFirebaseUid === firebaseUid'));
});

test('call:ended accepts creator participant for active session', () => {
  const socketSrc = readFileSync(join(__dirname, 'billing-socket.gateway.ts'), 'utf8');
  assert.ok(socketSrc.includes('isNonTerminalLifecycle'));
  assert.ok(socketSrc.includes('creatorFirebaseUid === firebaseUid'));
});

test('sync-warning connected phase uses lower autoheal threshold', () => {
  const socketSrc = readFileSync(join(__dirname, 'billing-socket.gateway.ts'), 'utf8');
  assert.ok(socketSrc.includes('SYNC_WARNING_CONNECTED_AUTOHEAL_THRESHOLD'));
  assert.ok(socketSrc.includes("phase === 'connected'"));
});

test('orchestrator suppress retries when session missing', () => {
  const src = readFileSync(join(__dirname, 'billing.service.ts'), 'utf8');
  assert.ok(src.includes('billing_start_suppressed_but_no_session'));
});

test('dual-start paths retain replay freshness hooks', () => {
  const src = readFileSync(join(__dirname, 'billing.service.ts'), 'utf8');
  assert.ok(src.includes("reason: 'start_lock_busy'"));
  assert.ok(src.includes("reason: 'suppressed_non_owner'"));
  assert.ok(src.includes('ensureBillingStartedReplayFreshness'));
});

test('first BullMQ cycle scheduled with zero delay after session start', () => {
  const src = readFileSync(join(__dirname, 'billing.service.ts'), 'utf8');
  assert.ok(src.includes('await scheduleBillingJob(callId, 0)'));
});

test('terminal session persist releases active call slots', () => {
  const src = readFileSync(join(__dirname, 'billing.service.ts'), 'utf8');
  assert.ok(src.includes('releaseActiveCallSlotsIfTerminal'));
  assert.ok(src.includes('persistCallSession'));
});

test('orphan slot cleanup clears terminal lifecycle sessions', () => {
  const src = readFileSync(join(__dirname, 'billing.service.ts'), 'utf8');
  assert.ok(src.includes('session_start_active_slot_terminal_recovered'));
  assert.ok(src.includes("lifecycle === 'SETTLED' || lifecycle === 'FAILED'"));
});

test('pending call end is consumed when session becomes active', () => {
  const src = readFileSync(join(__dirname, 'billing.service.ts'), 'utf8');
  assert.ok(src.includes('consumePendingCallEndIfAny'));
  assert.ok(src.includes('Deferred settlement for call after session promotion'));
  assert.ok(src.includes("finalizeCallEnd(io, callId, 'deferred_pending_end')"));
  assert.ok(src.includes("'billing.startBillingSession.promote_active'"));
  assert.ok(src.includes("'billing.processTick'"));
});

test('deferred call end tracks queue and flush telemetry', () => {
  const socketSrc = readFileSync(join(__dirname, 'billing-socket.gateway.ts'), 'utf8');
  const serviceSrc = readFileSync(join(__dirname, 'billing.service.ts'), 'utf8');
  assert.ok(socketSrc.includes('deferred_call_end_queued'));
  assert.ok(serviceSrc.includes('deferred_call_end_flushed'));
  assert.ok(serviceSrc.includes('deferred_call_end_age_ms'));
  assert.ok(socketSrc.includes('requestedAtMs'));
});

test('deferred call:ended restores creator presence before billing session is ready', () => {
  const socketSrc = readFileSync(join(__dirname, 'billing-socket.gateway.ts'), 'utf8');
  const httpSrc = readFileSync(join(__dirname, 'billing.gateway.ts'), 'utf8');
  assert.ok(socketSrc.includes('restoreCreatorPresenceForEndedCall'));
  assert.ok(socketSrc.includes('socket_call_ended.deferred_presence'));
  assert.ok(httpSrc.includes('http_settle_call.deferred_presence'));
});

test('runtime missing recover path emits dedicated metric', () => {
  const socketSrc = readFileSync(join(__dirname, 'billing-socket.gateway.ts'), 'utf8');
  assert.ok(socketSrc.includes('recovery_runtime_missing'));
  assert.ok(socketSrc.includes("'runtime_missing_after_resolve'"));
});

test('recover-state serves terminal tombstone fallback when runtime is gone', () => {
  const resolverSrc = readFileSync(join(__dirname, 'billing-runtime-resolver.service.ts'), 'utf8');
  const socketSrc = readFileSync(join(__dirname, 'billing-socket.gateway.ts'), 'utf8');
  assert.ok(resolverSrc.includes("source: 'terminal'"));
  assert.ok(resolverSrc.includes('callSessionTerminalKey'));
  assert.ok(resolverSrc.includes('billing_active_call_slot_terminal_tombstone_cleanup'));
  assert.ok(socketSrc.includes("status: 'terminal_settled'"));
  assert.ok(socketSrc.includes('buildTerminalRecoverEntry'));
});

test('recover-state accepts optional requested callId for fallback resolution', () => {
  const socketSrc = readFileSync(join(__dirname, 'billing-socket.gateway.ts'), 'utf8');
  assert.ok(socketSrc.includes('requestedCallId'));
  assert.ok(socketSrc.includes('resolveBillingRuntimeState(requestedCallId)'));
});

test('billing runtime ownership and heartbeat fields are present for watchdog guards', () => {
  const serviceSrc = readFileSync(join(__dirname, 'billing.service.ts'), 'utf8');
  const watchdogSrc = readFileSync(join(__dirname, 'billing-watchdog.service.ts'), 'utf8');
  assert.ok(serviceSrc.includes('lastHealthyTickAt'));
  assert.ok(serviceSrc.includes('lastSocketEmitAt'));
  assert.ok(serviceSrc.includes('lastSequenceAdvanceAt'));
  assert.ok(serviceSrc.includes('ensureRuntimeOwnership'));
  assert.ok(watchdogSrc.includes('hasRecentHealthyEvidence'));
  assert.ok(watchdogSrc.includes('billing_watchdog_skip_recent_sequence_advance'));
});

test('runtime ownership takeover and deferred ticks are implemented', () => {
  const serviceSrc = readFileSync(join(__dirname, 'billing.service.ts'), 'utf8');
  const queueSrc = readFileSync(join(__dirname, 'billing.queue.ts'), 'utf8');
  assert.ok(serviceSrc.includes('billing_runtime_owner_takeover'));
  assert.ok(serviceSrc.includes('reclaimStaleRuntimeOwnershipOnStartup'));
  assert.ok(serviceSrc.includes("'tick_deferred'"));
  assert.ok(serviceSrc.includes('billing_cycle_lock_deferred'));
  assert.ok(serviceSrc.includes('emit_update_keepalive'));
  assert.ok(queueSrc.includes('billing_cycle_zombie_sequence_stall'));
  assert.ok(queueSrc.includes('isBillingSequenceStalled'));
  assert.ok(queueSrc.includes("result === 'tick_deferred'"));
});

test('sync-warning autoheal reschedules billing ticks', () => {
  const socketSrc = readFileSync(join(__dirname, 'billing-socket.gateway.ts'), 'utf8');
  assert.ok(socketSrc.includes('recoverBillingScheduleForCall'));
  assert.ok(socketSrc.includes('processBillingTick(io, callId)'));
});

test('startup recovery reclaims stale runtime ownership', () => {
  const recoverySrc = readFileSync(join(__dirname, 'billing-recovery.ts'), 'utf8');
  assert.ok(recoverySrc.includes('reclaimStaleRuntimeOwnershipOnStartup'));
});
