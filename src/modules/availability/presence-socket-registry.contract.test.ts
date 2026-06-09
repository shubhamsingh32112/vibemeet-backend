import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('redis.ts exports presence socket registry key helpers', () => {
  const src = readFileSync(join(__dirname, '../../config/redis.ts'), 'utf8');
  assert.ok(src.includes('PRESENCE_SOCKETS_KEY_PREFIX'));
  assert.ok(src.includes('presenceSocketsKey'));
  assert.ok(src.includes('presenceHbOwnerKey'));
  assert.ok(src.includes('presenceDisconnectGraceKey'));
});

test('presence-socket-registry uses versioned unregister Lua', () => {
  const src = readFileSync(join(__dirname, 'presence-socket-registry.service.ts'), 'utf8');
  assert.ok(src.includes('UNREGISTER_SOCKET_SCRIPT'));
  assert.ok(src.includes('tonumber(record.version)'));
  assert.ok(src.includes("redis.call('DEL', socketsKey)"));
  assert.ok(src.includes('RENEW_HEARTBEAT_LEASE_SCRIPT'));
});

test('availability.gateway does not import listSocketIds', () => {
  const src = readFileSync(join(__dirname, 'availability.gateway.ts'), 'utf8');
  assert.ok(!src.includes('listSocketIds'));
});

test('availability.gateway sweeps do not EXPIRE presence:sockets keys', () => {
  const src = readFileSync(join(__dirname, 'availability.gateway.ts'), 'utf8');
  const sweepBlock = src.slice(src.indexOf('sweepStaleHeartbeats'), src.indexOf('export function setupAvailabilityGateway'));
  const cleanupBlock = src.slice(
    src.indexOf('cleanupStaleSocketTracking'),
    src.indexOf('function normalizeCreatorIds')
  );
  assert.ok(!sweepBlock.includes('presence:sockets'));
  assert.ok(!cleanupBlock.includes('presence:sockets'));
  assert.ok(!sweepBlock.includes('presenceSocketsKey'));
  assert.ok(!cleanupBlock.includes('presenceSocketsKey'));
});
