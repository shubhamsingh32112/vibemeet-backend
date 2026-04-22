import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const controllerPath = join(__dirname, 'payment.controller.ts');

test('payment webhook handler does not use fire-and-forget setImmediate', () => {
  const src = readFileSync(controllerPath, 'utf8');
  assert.ok(
    !src.includes('setImmediate(async () =>'),
    'webhook handler must not ack before durable processing'
  );
  assert.ok(
    src.includes('processStoredRazorpayWebhookEvent'),
    'webhook handler should use durable processing function'
  );
});

test('payment webhook dedup id must be deterministic without Date.now fallback', () => {
  const src = readFileSync(controllerPath, 'utf8');
  assert.ok(
    src.includes("createHash('sha256')"),
    'expected payload hash based event fingerprint'
  );
  assert.ok(
    !src.includes('payload.created_at || Date.now()'),
    'should not use non-deterministic Date.now dedup fallback'
  );
});

