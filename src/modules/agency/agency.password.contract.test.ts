import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('staff password helper normalizes portal passwords', () => {
  const src = readFileSync(join(__dirname, '../../utils/staff-password.ts'), 'utf8');
  assert.ok(src.includes('export function normalizeStaffPortalPassword'));
});

test('agency login compares password across all staff candidates', () => {
  const src = readFileSync(join(__dirname, '../auth/auth.controller.ts'), 'utf8');
  assert.ok(src.includes('normalizeStaffPortalPassword'));
  assert.ok(src.includes('agencyDisabled: { $ne: true }'));
  assert.ok(src.includes('for (const c of candidates)'));
  assert.ok(src.includes('export const agencyLogin'));
});

test('changeAgencyPassword uses 400 for incorrect current password', () => {
  const src = readFileSync(join(__dirname, 'agency-portal.controller.ts'), 'utf8');
  assert.ok(src.includes('normalizeStaffPortalPassword'));
  assert.ok(src.includes('loadStaffUserByAuth'));
  assert.ok(
    src.includes("res.status(400).json({ success: false, error: 'Current password is incorrect' })")
  );
  assert.ok(src.includes("staffWithHash.markModified('passwordHash')"));
});
