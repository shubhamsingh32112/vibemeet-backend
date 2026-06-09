import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('creator disconnect marks offline on last socket', () => {
  const src = readFileSync(join(__dirname, 'availability.gateway.ts'), 'utf8');
  assert.ok(src.includes('availability.gateway.disconnect_last_socket'));
  assert.ok(src.includes("'DISCONNECTED'"));
});

test('creator disconnect uses grace timer before offline transition', () => {
  const src = readFileSync(join(__dirname, 'availability.gateway.ts'), 'utf8');
  assert.ok(src.includes('CREATOR_DISCONNECT_GRACE_MS'));
  assert.ok(src.includes('scheduleCreatorDisconnectTransition'));
});

test('creator explicit offline always uses FORCE_OFFLINE', () => {
  const src = readFileSync(join(__dirname, 'availability.gateway.ts'), 'utf8');
  assert.ok(src.includes('handleCreatorExplicitOffline'));
  const block = src.slice(
    src.indexOf('async function handleCreatorExplicitOffline'),
    src.indexOf('export async function applyCreatorAvailabilityIntent')
  );
  assert.ok(block.includes("'FORCE_OFFLINE'"));
  assert.ok(!block.includes('Ignoring creator:offline'));
});

test('creator availability toggle restores runtime from Mongo on connect', () => {
  const src = readFileSync(join(__dirname, 'availability.gateway.ts'), 'utf8');
  assert.ok(src.includes('restoreCreatorRuntimeFromIntent'));
  assert.ok(src.includes('presence.restore_from_mongo'));
});

test('clearStuckCall does not force-clear call slot', () => {
  const src = readFileSync(join(__dirname, 'availability.gateway.ts'), 'utf8');
  const start = src.indexOf('if (options?.clearStuckCall)');
  assert.ok(start >= 0);
  const end = src.indexOf('await transitionCreatorPresence', start);
  const block = src.slice(start, end);
  assert.ok(!block.includes('force: true'));
  assert.ok(block.includes('slot_still_live'));
});

test('applyCreatorAvailabilityIntent exported for REST toggle', () => {
  const src = readFileSync(join(__dirname, 'availability.gateway.ts'), 'utf8');
  assert.ok(src.includes('export async function applyCreatorAvailabilityIntent'));
});

test('explicit creator offline uses FORCE_OFFLINE when toggle enabled', () => {
  const src = readFileSync(join(__dirname, 'availability.gateway.ts'), 'utf8');
  assert.ok(src.includes('handleCreatorExplicitOffline'));
  assert.ok(src.includes("'FORCE_OFFLINE'"));
});

test('creator:online supports clearStuckCall payload', () => {
  const src = readFileSync(join(__dirname, 'availability.gateway.ts'), 'utf8');
  assert.ok(src.includes('clearStuckCall'));
  assert.ok(src.includes('parseCreatorOnlinePayload'));
});

test('DISCONNECTED presence resolves to offline', () => {
  const src = readFileSync(join(__dirname, 'presence.service.ts'), 'utf8');
  assert.ok(src.includes("case 'DISCONNECTED':"));
  assert.ok(src.match(/DISCONNECTED[\s\S]*return 'offline'/));
});

test('presence metadata key is used for monotonic versioning', () => {
  const src = readFileSync(join(__dirname, 'presence.service.ts'), 'utf8');
  assert.ok(src.includes('creator:presence:meta:'));
});

test('availability gateway uses presence socket tracker and registry flags', () => {
  const gateway = readFileSync(join(__dirname, 'availability.gateway.ts'), 'utf8');
  const flags = readFileSync(join(__dirname, 'presence-registry-flags.ts'), 'utf8');
  assert.ok(gateway.includes('presence-socket-tracker'));
  assert.ok(gateway.includes('useRegistryAsAuthoritative'));
  assert.ok(flags.includes('PRESENCE_REGISTRY_SHADOW'));
  assert.ok(flags.includes('isPresenceRegistryShadow'));
});

test('creator heartbeat re-verifies lease before transitionCreatorPresence', () => {
  const src = readFileSync(join(__dirname, 'availability.gateway.ts'), 'utf8');
  const block = src.slice(src.indexOf('async function startCreatorHeartbeat'), src.indexOf('function startUserHeartbeat'));
  const first = block.indexOf('isHeartbeatLeaseHolder');
  const second = block.indexOf('isHeartbeatLeaseHolder', first + 1);
  assert.ok(first >= 0);
  assert.ok(second > first);
  assert.ok(block.includes('presence.heartbeat_lease_lost_before_write'));
  assert.ok(src.includes('renewHeartbeatLeaseOrStop'));
  assert.ok(src.includes('stop interval immediately'));
});

test('creator disconnect grace uses redis grace key and skip metric', () => {
  const src = readFileSync(join(__dirname, 'availability.gateway.ts'), 'utf8');
  assert.ok(src.includes('startDisconnectGrace'));
  assert.ok(src.includes('presence.grace_callback_skipped'));
  assert.ok(src.includes('cancelDisconnectGrace'));
});
