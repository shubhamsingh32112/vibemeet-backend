/**
 * Contract tests for blurhash BullMQ job helpers (no Redis / queue I/O).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blurhashJobId } from './blurhash.job-id';

test('blurhashJobId is colon-free for BullMQ custom id validation', () => {
  const imageId = '4206103e-ec4c-4e92-e532-dbdc528ce300';
  const jobId = blurhashJobId(imageId);
  assert.equal(jobId, `blurhash-${imageId}`);
  assert.ok(!jobId.includes(':'));
});
