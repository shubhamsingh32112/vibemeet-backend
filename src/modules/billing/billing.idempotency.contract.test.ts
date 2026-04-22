import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('settlement avoids absolute user coin overwrite', () => {
  const src = readFileSync(join(__dirname, 'billing-settlement.service.ts'), 'utf8');
  assert.ok(
    !src.includes('user.coins = Math.max(0, microsToWholeCoinsFloor(balanceMicros));'),
    'settlement must not overwrite user coins with absolute Redis snapshot'
  );
  assert.ok(src.includes("$subtract: ['$coins', userDebitDelta]"));
});

test('billing start path uses start lock and atomic slot reservation', () => {
  const src = readFileSync(join(__dirname, 'billing.service.ts'), 'utf8');
  assert.ok(src.includes('billingSessionStartLockKey'));
  assert.ok(src.includes('session_start_duplicate'));
  assert.ok(src.includes('local userExisting = redis.call("GET", KEYS[1])'));
});

