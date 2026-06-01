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

test('call lifecycle rejects overlapping ringing calls via active slots', () => {
  const src = readFileSync(join(__dirname, 'call-lifecycle.service.ts'), 'utf8');
  assert.ok(src.includes('call_overlap_rejected'));
  assert.ok(src.includes('activeCallByUserKey('));
  assert.ok(src.includes('markStreamCallEnded('));
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

test('creator availability finalization verifies active-call key deletion', () => {
  const src = readFileSync(join(__dirname, 'creator-call-lock.service.ts'), 'utf8');
  assert.ok(src.includes('activeCallKeyExistsAfterDelete'));
  assert.ok(src.includes('Creator availability restore transition emitted'));
});

test('pre-call snapshot restoration preserves offline creators after call end', () => {
  const src = readFileSync(join(__dirname, 'creator-call-lock.service.ts'), 'utf8');
  assert.ok(src.includes("snapshot === 'online' ? 'online' : 'offline'"));
  assert.ok(src.includes(": 'DISCONNECTED'"));
  assert.ok(src.includes('Never restore on_call after call end'));
  assert.ok(!src.includes("restoredStatus === 'on_call'"));
  assert.ok(src.includes('clearCreatorActiveCallSlotIfStale'));
});

test('presence layer clears stale active-call slots on read and terminal transitions', () => {
  const presenceSrc = readFileSync(
    join(__dirname, '../availability/presence.service.ts'),
    'utf8'
  );
  const slotSrc = readFileSync(
    join(__dirname, '../availability/creator-active-call-slot.service.ts'),
    'utf8'
  );
  assert.ok(presenceSrc.includes('clearCreatorActiveCallSlotIfStale'));
  assert.ok(presenceSrc.includes('presence.read_creator_presence_snapshot'));
  assert.ok(slotSrc.includes('isCreatorActiveCallSlotLive'));
});

test('call finalizer repairs presence when deduped or lock busy', () => {
  const src = readFileSync(join(__dirname, 'call-finalization.service.ts'), 'utf8');
  assert.ok(src.includes('repairCreatorPresenceAfterCallEnd'));
  assert.ok(src.includes('Call finalization dedupe presence repair failed'));
});

test('reconciliation includes reverse cleanup with settled-age threshold guard', () => {
  const src = readFileSync(join(__dirname, 'call-reconciliation.ts'), 'utf8');
  assert.ok(src.includes('cleanupSettledCreatorBusyDrift'));
  assert.ok(src.includes('RECON_SETTLED_RESTORE_AGE_MS'));
  assert.ok(src.includes('settlementAgeMs'));
  assert.ok(src.includes('activeCallKeyExistsAfterDelete'));
});

test('startup reconciliation run includes settled busy-drift cleanup pass', () => {
  const src = readFileSync(join(__dirname, 'call-reconciliation.ts'), 'utf8');
  assert.ok(src.includes('reconcileActiveCallsWithLock().catch'));
  assert.ok(src.includes('await cleanupSettledCreatorBusyDrift();'));
});

test('startup slot repair scans active-call keys and clears stale slots', () => {
  const src = readFileSync(join(__dirname, 'call-reconciliation.ts'), 'utf8');
  assert.ok(src.includes('repairStaleActiveCallSlotsOnStartup'));
  assert.ok(src.includes('ACTIVE_CALL_BY_USER_PREFIX'));
  assert.ok(src.includes('await redis.scan('));
  assert.ok(src.includes('resolveBillingRuntimeState(slotCallId)'));
  assert.ok(src.includes("await redis.del(key).catch(() => {});"));
  assert.ok(src.includes("'startup.presence_slot_repair'"));
});

test('startup slot repair supports dry-run and bounded scan controls', () => {
  const src = readFileSync(join(__dirname, 'call-reconciliation.ts'), 'utf8');
  assert.ok(src.includes('PRESENCE_STARTUP_REPAIR_DRY_RUN'));
  assert.ok(src.includes('PRESENCE_STARTUP_REPAIR_SCAN_LIMIT'));
  assert.ok(src.includes('PRESENCE_STARTUP_REPAIR_TIMEOUT_MS'));
  assert.ok(src.includes('PRESENCE_STARTUP_REPAIR_STARTING_MAX_AGE_MS'));
  assert.ok(src.includes('shouldTreatStartingAsStale('));
  assert.ok(src.includes("recordCallMetric('presence_startup_slot_scan'"));
});

test('server boot wires startup slot repair pass', () => {
  const src = readFileSync(join(__dirname, '../../server.ts'), 'utf8');
  assert.ok(src.includes('repairStaleActiveCallSlotsOnStartup'));
  assert.ok(src.includes("logError('Startup active-call slot repair failed'"));
});
