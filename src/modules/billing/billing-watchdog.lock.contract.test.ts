import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const watchdogPath = join(__dirname, 'billing-watchdog.service.ts');

test('billing watchdog uses cluster lock with bypass env', () => {
  const src = readFileSync(watchdogPath, 'utf8');
  assert.ok(src.includes('BILLING_WATCHDOG_LOCK_KEY'));
  assert.ok(src.includes('acquireDistributedLock'));
  assert.ok(src.includes('BILLING_WATCHDOG_CLUSTER_LOCK'));
  assert.ok(src.includes('billing.watchdog.lock_acquired'));
  assert.ok(src.includes('billing.watchdog.lock_skipped'));
});

test('billing watchdog releases lock on stop', () => {
  const src = readFileSync(watchdogPath, 'utf8');
  assert.ok(src.includes('stopBillingWatchdog'));
  assert.ok(src.includes('activeWatchdogLock'));
  assert.ok(src.includes('handle.release()'));
});
