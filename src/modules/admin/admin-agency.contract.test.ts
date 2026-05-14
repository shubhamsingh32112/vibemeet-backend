/**
 * Contract tests for super-admin BD + agency management after hierarchy swap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('admin routes must wire DELETE /bds/:id to deleteBd', () => {
  const src = readFileSync(join(__dirname, 'admin.routes.ts'), 'utf8');
  assert.ok(src.includes('deleteBd'), 'expected deleteBd import');
  assert.ok(src.includes("router.delete('/bds/:id', deleteBd)"), 'expected DELETE /bds/:id route');
});

test('deleteBd must enforce guards and deleted identities', () => {
  const src = readFileSync(join(__dirname, 'admin-bd.controller.ts'), 'utf8');
  assert.ok(src.includes('export const deleteBd'), 'expected deleteBd export');
  assert.ok(src.includes('AGENCY_ROLE_QUERY'), 'expected middle-tier agency count guard');
  assert.ok(
    src.includes("Withdrawal.countDocuments({ staffUserId: agencyOid, status: 'pending' })"),
    'expected pending staff withdrawal guard'
  );
  assert.ok(src.includes('staffCoinsBalance'), 'expected staff wallet balance guard');
  assert.ok(src.includes('upsertDeletedIdentities'), 'expected deleted-identity upsert before delete');
  assert.ok(src.includes("'agency_deleted'"), 'expected agency_deleted audit event');
});

test('createAgency must block deleted identities', () => {
  const src = readFileSync(join(__dirname, 'admin-agency.controller.ts'), 'utf8');
  assert.ok(src.includes('checkDeletedStatus'), 'expected checkDeletedStatus on create');
  assert.ok(src.includes("role: 'agency'"), 'expected middle-tier agency role on create');
});

test('assertAgency must reject when parent BD row is missing or not bd role', () => {
  const src = readFileSync(join(__dirname, '../../middlewares/staff.middleware.ts'), 'utf8');
  assert.ok(src.includes("!isBdRole(parent.role)"), 'expected parent BD role check');
  assert.ok(
    src.includes('BD no longer exists — agency portal access suspended'),
    'expected stable agency error copy'
  );
});

test('agencyLogin must block when parent BD missing or disabled', () => {
  const src = readFileSync(join(__dirname, '../auth/auth.controller.ts'), 'utf8');
  assert.ok(src.includes('Agency login blocked: parent BD missing'), 'expected parent BD missing check');
  assert.ok(src.includes('Agency login blocked: parent BD disabled'), 'expected parent BD disabled check');
});

test('createBdAgency must check deleted email status', () => {
  const src = readFileSync(join(__dirname, '../bd/bd-portal.controller.ts'), 'utf8');
  assert.ok(
    src.includes('checkDeletedStatus({ email, phone: null })'),
    'expected createBdAgency deleted-identity check'
  );
});

test('createAgency (admin) must check deleted email status', () => {
  const src = readFileSync(join(__dirname, 'admin-agency.controller.ts'), 'utf8');
  assert.ok(
    src.includes('checkDeletedStatus({ email, phone: null })'),
    'expected createAgency deleted-identity check'
  );
});
