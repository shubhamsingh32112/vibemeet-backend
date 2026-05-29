import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('billing start paths use orchestrator gate and replay freshness helper', () => {
  const src = readFileSync(join(__dirname, 'billing.service.ts'), 'utf8');
  assert.ok(src.includes('billingStartOrchestratorKey(callId)'));
  assert.ok(src.includes("reason: 'suppressed_non_owner'"));
  assert.ok(src.includes('ensureBillingStartedReplayFreshness'));
  assert.ok(src.includes('waitForSessionSnapshot'));
  assert.ok(src.includes("replayReason: 'suppressed_retry_waited_session'"));
});

test('gateway start telemetry uses startCorrelationId and startIngress', () => {
  const socketSrc = readFileSync(join(__dirname, 'billing-socket.gateway.ts'), 'utf8');
  const gatewaySrc = readFileSync(join(__dirname, 'billing.gateway.ts'), 'utf8');
  assert.ok(socketSrc.includes('startCorrelationId'));
  assert.ok(socketSrc.includes("startIngress: 'socket'"));
  assert.ok(gatewaySrc.includes('startCorrelationId'));
  assert.ok(gatewaySrc.includes("startIngress: opts?.startIngress ?? 'http'"));
});

test('recover-state response includes request metadata and debounce suppression', () => {
  const socketSrc = readFileSync(join(__dirname, 'billing-socket.gateway.ts'), 'utf8');
  const emitterSrc = readFileSync(join(__dirname, 'billing-emitter.service.ts'), 'utf8');
  assert.ok(socketSrc.includes('recoveryRequestId'));
  assert.ok(socketSrc.includes('state_recovery_suppressed'));
  assert.ok(socketSrc.includes('emitSuppressedRecoverySnapshot'));
  assert.ok(socketSrc.includes('recoveryGateByUid'));
  assert.ok(emitterSrc.includes('generatedAtMs'));
  assert.ok(emitterSrc.includes('runtimeSource'));
});

test('sync-warning path dedupes and has auto-heal metric hooks', () => {
  const socketSrc = readFileSync(join(__dirname, 'billing-socket.gateway.ts'), 'utf8');
  assert.ok(socketSrc.includes('billingSyncWarningDedupKey'));
  assert.ok(socketSrc.includes('billing_sync_warning_deduped'));
  assert.ok(socketSrc.includes('billing_sync_autoheal_triggered'));
  assert.ok(socketSrc.includes('billing_sync_autoheal_success'));
});

test('http settle defers with structured pending payload', () => {
  const src = readFileSync(join(__dirname, 'billing.gateway.ts'), 'utf8');
  assert.ok(src.includes('requestedAtMs'));
  assert.ok(src.includes('http_settle_call'));
});

test('webhook existing-session path uses replay guard helper', () => {
  const src = readFileSync(join(__dirname, '../video/call-lifecycle.service.ts'), 'utf8');
  assert.ok(src.includes('ensureBillingStartedReplayFreshness'));
  assert.ok(src.includes("source: 'webhook_session_started'"));
});

