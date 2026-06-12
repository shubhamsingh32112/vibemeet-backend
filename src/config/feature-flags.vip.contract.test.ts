import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('VIP feature flags use opt-in semantics', () => {
  const src = readFileSync(join(__dirname, 'feature-flags.ts'), 'utf8');
  assert.ok(src.includes("vipEnabled: process.env.VIP_ENABLED === 'true'"));
  assert.ok(src.includes("vipSchedulingEnabled: process.env.VIP_SCHEDULING_ENABLED === 'true'"));
  assert.ok(src.includes("vipPriorityQueueEnabled: process.env.VIP_PRIORITY_QUEUE_ENABLED === 'true'"));
});
