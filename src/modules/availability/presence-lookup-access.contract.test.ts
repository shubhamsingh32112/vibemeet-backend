import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const gatewayPath = join(__dirname, 'availability.gateway.ts');
const accessPath = join(__dirname, 'presence-lookup-access.ts');

test('user:availability:get enforces creator/admin guard and batch cap', () => {
  const gateway = readFileSync(gatewayPath, 'utf8');
  assert.ok(gateway.includes('assertCreatorOrAdminForPresenceLookup'));
  assert.ok(gateway.includes('capPresenceLookupBatch'));
  assert.ok(gateway.includes('checkPresenceLookupRateLimit'));
  assert.ok(gateway.includes("'user:availability:error'"));

  // user:availability:get must keep the assert (fan scrape protection).
  const userGetIdx = gateway.indexOf("socket.on('user:availability:get'");
  assert.ok(userGetIdx >= 0, 'user:availability:get handler missing');
  const nextOn = gateway.indexOf('socket.on(', userGetIdx + 1);
  const userBlock = gateway.slice(userGetIdx, nextOn > 0 ? nextOn : undefined);
  assert.ok(
    userBlock.includes('assertCreatorOrAdminForPresenceLookup'),
    'user:availability:get must call assertCreatorOrAdminForPresenceLookup'
  );
});

test('availability:get is fan-safe (no creator/admin assert)', () => {
  const gateway = readFileSync(gatewayPath, 'utf8');
  const marker = "Fan-safe: any authenticated socket may batch-resolve creator presence";
  const start = gateway.indexOf(marker);
  assert.ok(start >= 0, 'availability:get fan-safe marker missing');
  const creatorOnline = gateway.indexOf("socket.on('creator:online'", start + 1);
  const block = gateway.slice(start, creatorOnline > 0 ? creatorOnline : start + 4000);
  assert.ok(block.includes("'availability:get'"), 'availability:get handler missing in block');
  assert.ok(
    !block.includes('assertCreatorOrAdminForPresenceLookup'),
    'availability:get must NOT call assertCreatorOrAdminForPresenceLookup (fans need rehydrate)'
  );
  assert.ok(block.includes('checkPresenceLookupRateLimit'));
  assert.ok(block.includes('capPresenceLookupBatch'));
});

test('presence lookup auth can be disabled via env', () => {
  const access = readFileSync(accessPath, 'utf8');
  assert.ok(access.includes('PRESENCE_LOOKUP_AUTH_ENFORCED'));
});
