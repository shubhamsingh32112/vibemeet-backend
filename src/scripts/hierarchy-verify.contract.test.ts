import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('verify script checks legacy roles and creator field', () => {
  const src = readFileSync(join(__dirname, 'verify-agency-bd-hierarchy-swap.ts'), 'utf8');
  assert.ok(src.includes("role: 'agent'"), 'expected agent role count check');
  assert.ok(src.includes('assignedAgentId'), 'expected assignedAgentId absence check');
  assert.ok(src.includes('pending_bd_approval'), 'expected onboarding status check');
  assert.ok(src.includes("role: 'agency'"), 'expected agency role validation');
});
