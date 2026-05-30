/**
 * Contract tests for termination retry BullMQ job helpers (no Redis / queue I/O).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminateCallJobId } from './billing-termination.job-id';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('terminateCallJobId is colon-free for BullMQ custom id validation', () => {
  const jobId = terminateCallJobId('call-abc');
  assert.equal(jobId, 'terminate-call-abc');
  assert.ok(!jobId.includes(':'));
});

test('markStreamCallEnded treats 404 as idempotent when enabled', () => {
  const src = readFileSync(join(__dirname, 'billing-termination.stream.ts'), 'utf8');
  assert.ok(src.includes('responseStatus === 404'));
  assert.ok(src.includes('responseCode === 4'));
  assert.ok(src.includes("return { outcome: 'not_found', statusCode: 404 }"));
});

test('termination retry worker records stream outcome tags', () => {
  const src = readFileSync(join(__dirname, 'billing-termination.queue.ts'), 'utf8');
  assert.ok(src.includes('streamResult: streamResult.outcome'));
  assert.ok(src.includes('force_terminate_retry_not_found_idempotent'));
});
