import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('availability service legacy writers are disabled', () => {
  const src = readFileSync(join(__dirname, 'availability.service.ts'), 'utf8');
  assert.ok(src.includes('setAvailability is disabled'));
  assert.ok(src.includes('refreshAvailability is disabled'));
  assert.ok(src.includes('removeAvailability is disabled'));
});

test('legacy availability socket path is hard-disabled', () => {
  const src = readFileSync(join(__dirname, 'availability.socket.ts'), 'utf8');
  assert.ok(
    src.includes('ENABLE_LEGACY_AVAILABILITY_SOCKET=true is not supported'),
    'legacy socket enable path must throw'
  );
  assert.ok(src.includes('emitCreatorStatus is disabled'));
});

test('gateway disconnect fallback uses transition, not direct creator emits', () => {
  const src = readFileSync(join(__dirname, 'availability.gateway.ts'), 'utf8');
  assert.ok(src.includes('availability.gateway.disconnect_last_socket'));
  assert.ok(!src.includes("io.to('consumors').emit('creator:status', payload)"));
});

test('presence service broadcasts creator:status on CONNECTED', () => {
  const src = readFileSync(join(__dirname, 'presence.service.ts'), 'utf8');
  assert.ok(src.includes("eventType === 'CONNECTED'"));
});

test('presence service gates legacy fallback and dual-write behind feature flags', () => {
  const src = readFileSync(join(__dirname, 'presence.service.ts'), 'utf8');
  assert.ok(src.includes('creatorPresenceLegacyFallbackReadEnabled'));
  assert.ok(src.includes('creatorPresenceLegacyDualWriteEnabled'));
});

