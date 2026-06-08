import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const lockPath = join(__dirname, 'distributed-lock.ts');

test('distributed lock utility logs ownership lifecycle events', () => {
  const src = readFileSync(lockPath, 'utf8');
  for (const event of [
    'lock.acquired',
    'lock.released',
    'lock.expired',
    'lock.skipped',
    'lock.heartbeat_failed',
  ]) {
    assert.ok(src.includes(`'${event}'`), `expected ${event} logging`);
  }
  assert.ok(src.includes('instanceId'), 'expected instanceId in lock logs');
  assert.ok(src.includes('lockKey'), 'expected lockKey in lock logs');
});

test('billing reconciliation uses shared distributed lock utility', () => {
  const reconPath = join(__dirname, '../modules/billing/billing-reconciliation.ts');
  const src = readFileSync(reconPath, 'utf8');
  assert.ok(src.includes("from '../../utils/distributed-lock'"));
  assert.ok(src.includes('withDistributedLock'));
});
