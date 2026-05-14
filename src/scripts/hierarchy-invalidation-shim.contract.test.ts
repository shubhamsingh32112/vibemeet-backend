import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('legacy invalidation shim maps assignedAgencyId to agency scope', () => {
  const src = readFileSync(
    join(__dirname, '../modules/staff/staff-dashboard-invalidation.service.ts'),
    'utf8'
  );
  assert.ok(
    src.includes("if (typeof d.assignedAgencyId === 'string') scope.agencyId = d.assignedAgencyId"),
    'expected assignedAgencyId to populate scope.agencyId'
  );
  assert.ok(
    src.includes("if (typeof d.agencyUserId === 'string') scope.agencyId = d.agencyUserId"),
    'expected agencyUserId to populate scope.agencyId'
  );
  assert.ok(
    src.includes('!scope.bdId && !scope.agencyId'),
    'expected staffUserId fallback to check both bdId and agencyId'
  );
});
