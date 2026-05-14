import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('migration script uses temp roles and field renames', () => {
  const src = readFileSync(join(__dirname, 'migrate-agency-bd-hierarchy-swap.ts'), 'utf8');
  assert.ok(src.includes('__swap_top__'), 'expected temp top role');
  assert.ok(src.includes('__swap_mid__'), 'expected temp mid role');
  assert.ok(src.includes('assignedAgencyId'), 'expected creator field rename');
  assert.ok(src.includes('pending_agency_approval'), 'expected onboarding status rewrite');
  assert.ok(src.includes('--apply'), 'expected apply flag');
});
