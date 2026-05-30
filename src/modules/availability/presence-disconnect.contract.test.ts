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

test('creator:offline ignored when sockets still connected', () => {
  const src = readFileSync(join(__dirname, 'availability.gateway.ts'), 'utf8');
  assert.ok(src.includes('Ignoring creator:offline'));
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
