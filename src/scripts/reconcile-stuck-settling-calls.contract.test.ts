import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('reconcile-stuck-settling-calls defaults to dry-run and supports execute actions', () => {
  const src = readFileSync(join(__dirname, 'reconcile-stuck-settling-calls.ts'), 'utf8');
  assert.ok(src.includes('--dry-run'));
  assert.ok(src.includes('--execute'));
  assert.ok(src.includes('--call-id'));
  assert.ok(src.includes('--min-age-ms'));
  assert.ok(src.includes("actionArg === 'dead-letter'"));
  assert.ok(src.includes('BILLING_MAX_SETTLING_MS'));
  assert.ok(src.includes('drainSettlementArtifacts'));
  assert.ok(src.includes('enqueueImmediateSettlementRetry'));
  assert.ok(src.includes("actionArg === 'recover-failed'"));
  assert.ok(src.includes('resetDurableCallSessionForSettlementRetry'));
  assert.ok(src.includes('resolveAuthoritativeSettlementTotals'));
});
