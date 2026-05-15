/**
 * Contract tests for termination retry BullMQ job helpers (no Redis / queue I/O).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminateCallJobId } from './billing-termination.job-id';

test('terminateCallJobId is colon-free for BullMQ custom id validation', () => {
  const jobId = terminateCallJobId('call-abc');
  assert.equal(jobId, 'terminate-call-abc');
  assert.ok(!jobId.includes(':'));
});
