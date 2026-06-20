import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('runSettlementOrphanRepair includes durable stale session repair', () => {
  const src = readFileSync(join(__dirname, 'billing-reconciliation.ts'), 'utf8');
  assert.ok(src.includes('durable_stale_'));
  assert.ok(src.includes("state: { $in: ['settling', 'ending'] }"));
  assert.ok(src.includes("state: 'failed_settlement'"));
  assert.ok(src.includes('attemptFailedSettlementRecovery'));
  assert.ok(src.includes('isDurableCallSessionEnabled'));
});
