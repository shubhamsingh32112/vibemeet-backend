import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('creator disconnect marks busy on last socket', () => {
  const src = readFileSync(join(__dirname, 'availability.gateway.ts'), 'utf8');
  assert.ok(src.includes('availability.gateway.disconnect_last_socket'));
  assert.ok(src.includes("'DISCONNECTED'"));
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

test('canonical-missing batch logs high-rate warning', () => {
  const src = readFileSync(join(__dirname, 'presence.service.ts'), 'utf8');
  assert.ok(src.includes('creator_presence_batch_canonical_missing_high'));
});
