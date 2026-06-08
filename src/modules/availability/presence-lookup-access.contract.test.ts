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
});

test('presence lookup auth can be disabled via env', () => {
  const access = readFileSync(accessPath, 'utf8');
  assert.ok(access.includes('PRESENCE_LOOKUP_AUTH_ENFORCED'));
});
