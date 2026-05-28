import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('creator disconnect uses grace before marking away', () => {
  const src = readFileSync(join(__dirname, 'availability.gateway.ts'), 'utf8');
  assert.ok(src.includes('CREATOR_DISCONNECT_GRACE_MS'));
  assert.ok(src.includes('scheduleCreatorAway'));
  assert.ok(src.includes('creatorHasAnyConnectedSocket'));
});

test('creator:offline ignored when sockets still connected', () => {
  const src = readFileSync(join(__dirname, 'availability.gateway.ts'), 'utf8');
  assert.ok(src.includes('Ignoring creator:offline'));
});

test('DISCONNECTED presence resolves to busy', () => {
  const src = readFileSync(join(__dirname, 'presence.service.ts'), 'utf8');
  assert.ok(src.includes("case 'DISCONNECTED':"));
  assert.ok(src.match(/DISCONNECTED[\s\S]*return 'busy'/));
});

test('legacy fallback batch logs high rate warning', () => {
  const src = readFileSync(join(__dirname, 'presence.service.ts'), 'utf8');
  assert.ok(src.includes('creator_presence_batch_legacy_fallback_high'));
});
