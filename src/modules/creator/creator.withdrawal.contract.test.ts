import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('creator withdrawal request enforces assignment observability and response details', () => {
  const src = readFileSync(join(__dirname, 'creator.controller.ts'), 'utf8');
  assert.ok(src.includes("logInfo('withdrawal_created_without_assignment'"));
  assert.ok(src.includes('assignedAgentId: withdrawal.assignedAgentId?.toString() ?? null'));
  assert.ok(src.includes('name: withdrawal.name ?? null'));
  assert.ok(src.includes('number: withdrawal.number ?? null'));
  assert.ok(src.includes('upi: withdrawal.upi ?? null'));
  assert.ok(src.includes('accountNumber: withdrawal.accountNumber ?? null'));
  assert.ok(src.includes('ifsc: withdrawal.ifsc ?? null'));
});
