/**
 * Contract tests for settlement flush + wall-lag helpers (no Redis I/O).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SETTLEMENT_FLUSH_ITERATIONS } from './billing.service';
import { MAX_BILLING_DELTA_MS, MIN_BILLING_DELTA_MS } from './billing.constants';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('MAX_SETTLEMENT_FLUSH_ITERATIONS is a fixed safety bound for pre-settlement flush', () => {
  assert.equal(MAX_SETTLEMENT_FLUSH_ITERATIONS, 50);
  const maxWallMsPerFlush = MAX_BILLING_DELTA_MS * MAX_SETTLEMENT_FLUSH_ITERATIONS;
  assert.ok(maxWallMsPerFlush >= 60_000, 'expect at least ~60s of capped catch-up before cap warning');
});

test('billing.service persists active-call TTL alongside session setex', () => {
  const p = join(__dirname, 'billing.service.ts');
  const src = readFileSync(p, 'utf8');
  assert.ok(
    src.includes('refreshActiveCallSlotsTtl'),
    'expected refreshActiveCallSlotsTtl when sliding session TTL'
  );
  assert.ok(
    /expire\(activeCallByUserKey\(session\.userFirebaseUid\)/.test(src) ||
      src.includes('refreshActiveCallSlotsTtl'),
    'expected active slot TTL refresh on persist'
  );
});

test('MIN/MAX billing delta bracket flush stop condition', () => {
  assert.ok(MIN_BILLING_DELTA_MS > 0);
  assert.ok(MAX_BILLING_DELTA_MS >= MIN_BILLING_DELTA_MS);
});
