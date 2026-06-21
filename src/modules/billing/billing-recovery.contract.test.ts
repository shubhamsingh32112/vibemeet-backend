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

test('processTick short-circuits terminal lifecycle before insufficient balance path', () => {
  const src = readFileSync(join(__dirname, 'billing.service.ts'), 'utf8');
  assert.ok(src.includes('billing_tick_terminal_short_circuit'));
  assert.ok(src.includes('shortCircuitIfTerminalBillingSession'));
  const shortCircuitIdx = src.indexOf('shortCircuitIfTerminalBillingSession');
  const insufficientIdx = src.indexOf('insufficient_balance_pre_deduct');
  assert.ok(shortCircuitIdx >= 0 && insufficientIdx >= 0);
  assert.ok(shortCircuitIdx < insufficientIdx);
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

test('BullMQ stale watchdog skips terminal sessions before reschedule', () => {
  const src = readFileSync(join(__dirname, 'billing-reconciliation.ts'), 'utf8');
  assert.ok(src.includes('shouldRescheduleBillingCycleForSession'));
  assert.ok(src.includes('billing_bullmq_watchdog_terminal_skipped'));
});

test('sync-warning autoheal reschedules billing ticks', () => {
  const socketSrc = readFileSync(join(__dirname, 'billing-socket.gateway.ts'), 'utf8');
  const healSrc = readFileSync(join(__dirname, 'billing-heal.service.ts'), 'utf8');
  assert.ok(socketSrc.includes('healActiveCallBillingLight'));
  assert.ok(healSrc.includes('recoverBillingScheduleForCall'));
  assert.ok(healSrc.includes('healActiveCallBillingLight'));
  assert.ok(healSrc.includes('processBillingTick(io, callId)'));
});

test('recover-state uses lightweight resolver and empty cache on api-ws', () => {
  const socketSrc = readFileSync(join(__dirname, 'billing-socket.gateway.ts'), 'utf8');
  const resolverSrc = readFileSync(join(__dirname, 'billing-runtime-resolver.service.ts'), 'utf8');
  const gateSrc = readFileSync(join(__dirname, 'billing-recovery-gate.service.ts'), 'utf8');
  assert.ok(socketSrc.includes('allowScan: false'));
  assert.ok(socketSrc.includes('isRecoveryEmptyCached'));
  assert.ok(socketSrc.includes('markRecoveryEmptyOutcome'));
  assert.ok(resolverSrc.includes('allowScan?: boolean'));
  assert.ok(gateSrc.includes('BILLING_RECOVERY_EMPTY_DEBOUNCE_MS'));
  assert.ok(gateSrc.includes('billingRecoveryEmptyCacheKey'));
});

test('api-ws heal ticks do not drive admission backpressure', () => {
  const serviceSrc = readFileSync(join(__dirname, 'billing.service.ts'), 'utf8');
  assert.ok(serviceSrc.includes('runsBillingWorkers()'));
  assert.ok(serviceSrc.includes('updateBackpressureStage({ tickDriftMs })'));
  assert.ok(serviceSrc.includes('updateBackpressureStage({ redisWriteMs })'));
});

test('startup recovery reclaims stale runtime ownership', () => {
  const recoverySrc = readFileSync(join(__dirname, 'billing-recovery.ts'), 'utf8');
  assert.ok(recoverySrc.includes('reclaimStaleRuntimeOwnershipOnStartup'));
});

test('zero-price sessions use pricing repair before tick abort', () => {
  const serviceSrc = readFileSync(join(__dirname, 'billing.service.ts'), 'utf8');
  const repairSrc = readFileSync(
    join(__dirname, 'billing-session-pricing-repair.service.ts'),
    'utf8'
  );
  assert.ok(repairSrc.includes('repairSessionPricingIfNeeded'));
  assert.ok(repairSrc.includes('promoteBootstrappingSession'));
  assert.ok(repairSrc.includes('patchSessionPricingOnly'));
  assert.ok(repairSrc.includes('needsFullSessionBootstrap'));
  assert.ok(serviceSrc.includes('repairSessionPricingIfNeeded'));
  assert.ok(serviceSrc.includes("return 'tick_deferred'"));
  assert.ok(!serviceSrc.includes("Invalid pricePerSecondMicros', { callId, pricePerSecondMicros });\n        return 'stop_needs_settlement'"));
});

test('pricing repair uses patch path when participants exist but price is zero', () => {
  const repairSrc = readFileSync(
    join(__dirname, 'billing-session-pricing-repair.service.ts'),
    'utf8'
  );
  const serviceSrc = readFileSync(join(__dirname, 'billing.service.ts'), 'utf8');
  assert.ok(serviceSrc.includes('needsFullSessionBootstrap'));
  assert.ok(repairSrc.includes('if (needsFullSessionBootstrap(session))'));
  assert.ok(repairSrc.includes('return patchSessionPricingOnly(callId, session, source)'));
});

test('mid-call promote repair preserves runtime balances', () => {
  const serviceSrc = readFileSync(join(__dirname, 'billing.service.ts'), 'utf8');
  assert.ok(serviceSrc.includes('preserveRuntimeBalances'));
  assert.ok(serviceSrc.includes('preserveRuntimeBalances === true'));
  assert.ok(serviceSrc.includes('User.findById(userMongoId)'));
});

test('healing repairs pricing before rescheduling tick chain', () => {
  const healSrc = readFileSync(join(__dirname, 'billing-heal.service.ts'), 'utf8');
  assert.ok(healSrc.includes('repairSessionPricingIfNeeded'));
  assert.ok(healSrc.includes('pricing_unresolved'));
  assert.ok(healSrc.includes('hasValidSessionPricing'));
  assert.ok(healSrc.includes('tickResult === \'tick_ok\''));
  assert.ok(healSrc.includes('stop_needs_settlement') && healSrc.includes('hadValidPricing'));
});

test('pricing repair health events are defined', () => {
  const healthSrc = readFileSync(join(__dirname, 'billing-health-log.ts'), 'utf8');
  assert.ok(healthSrc.includes('PRICING_REPAIR_START'));
  assert.ok(healthSrc.includes('PRICING_REPAIR_DONE'));
  assert.ok(healthSrc.includes('PRICING_REPAIR_FAILED'));
});

test('checkpoint reconstruction backfills zero pricing from creator', () => {
  const resolverSrc = readFileSync(join(__dirname, 'billing-runtime-resolver.service.ts'), 'utf8');
  const serviceSrc = readFileSync(join(__dirname, 'billing.service.ts'), 'utf8');
  assert.ok(resolverSrc.includes('snapshotForCreatorCached'));
  assert.ok(resolverSrc.includes('billing_checkpoint_pricing_backfilled'));
  assert.ok(resolverSrc.includes('async function buildSessionFromCheckpoint'));
  assert.ok(serviceSrc.includes('billing_checkpoint_pricing_backfilled'));
  assert.ok(serviceSrc.includes('async function buildSessionFromCheckpoint'));
});

test('start billing session logs explicit rejection reasons', () => {
  const serviceSrc = readFileSync(join(__dirname, 'billing.service.ts'), 'utf8');
  assert.ok(serviceSrc.includes('billing_start_rejected_system_busy'));
  assert.ok(serviceSrc.includes('billing_start_rejected_bootstrap_in_progress'));
  assert.ok(serviceSrc.includes('billing_start_rejected_callpair_conflict'));
  assert.ok(serviceSrc.includes('billing_start_rejected_active_slot_conflict'));
  assert.ok(serviceSrc.includes('billing_start_rejected_promote_failed'));
  assert.ok(serviceSrc.includes('billing_start_rejected_start_lock_busy'));
});

test('stale callpair locks are cleared before rejecting new session start', () => {
  const serviceSrc = readFileSync(join(__dirname, 'billing.service.ts'), 'utf8');
  assert.ok(serviceSrc.includes('tryClearStaleCallpairLock'));
  assert.ok(serviceSrc.includes('billing_start_callpair_orphan_recovered'));
  assert.ok(serviceSrc.includes('session_start_callpair_orphan_recovered'));
});

test('promote repair reloads mongo balances when redis runtime is zero', () => {
  const serviceSrc = readFileSync(join(__dirname, 'billing.service.ts'), 'utf8');
  assert.ok(serviceSrc.includes('billing_promote_balance_from_mongo'));
  assert.ok(serviceSrc.includes("balanceSource: BalanceSource = 'mongo'"));
  assert.ok(serviceSrc.includes("'redis_runtime'"));
  assert.ok(serviceSrc.includes('writeRuntimeBalanceKeys'));
});
