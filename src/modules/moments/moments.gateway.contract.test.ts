import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const gatewayPath = join(__dirname, 'moments.gateway.ts');

test('emitMediaReady targets user firebaseUid room', () => {
  const src = readFileSync(gatewayPath, 'utf8');
  assert.ok(src.includes('`user:${firebaseUid}`'), 'media:ready must emit to user:{firebaseUid} room');
  assert.ok(!src.match(/\.to\(userId\)/), 'must not emit to raw mongo userId room');
});
