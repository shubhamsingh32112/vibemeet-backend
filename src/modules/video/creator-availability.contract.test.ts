import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('creator availability flow snapshots pre-call status with NX + TTL', () => {
  const src = readFileSync(join(__dirname, 'creator-call-lock.service.ts'), 'utf8');
  assert.ok(src.includes('PRECALL_SNAPSHOT_PREFIX'));
  assert.ok(src.includes("precallSnapshotKey(callId, creatorFirebaseUid)"));
  assert.ok(src.includes("'NX'"));
  assert.ok(src.includes("'EX'"));
});

test('call lifecycle routes busy and finalize through centralized helpers', () => {
  const src = readFileSync(join(__dirname, 'call-lifecycle.service.ts'), 'utf8');
  assert.ok(src.includes('markCreatorBusyForCall('));
  assert.ok(src.includes('finalizeCallEnd('));
  assert.ok(!src.includes('private async markCreatorBusy('));
});

test('call finalizer has idempotency lock and done markers', () => {
  const src = readFileSync(join(__dirname, 'call-finalization.service.ts'), 'utf8');
  assert.ok(src.includes('call:finalize:lock:'));
  assert.ok(src.includes('call:finalize:done:'));
  assert.ok(src.includes("'NX'"));
});

test('call reconciliation delegates ended-call cleanup to centralized finalizer', () => {
  const src = readFileSync(join(__dirname, 'call-reconciliation.ts'), 'utf8');
  assert.ok(src.includes('finalizeCallEnd('));
});
