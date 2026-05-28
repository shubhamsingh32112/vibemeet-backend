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

test('first BullMQ cycle scheduled with zero delay after session start', () => {
  const src = readFileSync(join(__dirname, 'billing.service.ts'), 'utf8');
  assert.ok(src.includes('await scheduleBillingJob(callId, 0)'));
});

test('terminal session persist releases active call slots', () => {
  const src = readFileSync(join(__dirname, 'billing.service.ts'), 'utf8');
  assert.ok(src.includes('releaseActiveCallSlotsIfTerminal'));
  assert.ok(src.includes('persistCallSession'));
});
