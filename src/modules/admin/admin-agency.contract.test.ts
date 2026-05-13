/**
 * Contract tests for super-admin agency management (delete, create guards, BD parent checks).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('admin routes must wire DELETE /agencies/:id to deleteAgency', () => {
  const src = readFileSync(join(__dirname, 'admin.routes.ts'), 'utf8');
  assert.ok(src.includes("deleteAgency"), 'expected deleteAgency import');
  assert.ok(
    src.includes("router.delete('/agencies/:id', deleteAgency)"),
    'expected DELETE /agencies/:id route'
  );
});

test('deleteAgency must enforce guards and deleted identities', () => {
  const src = readFileSync(join(__dirname, 'admin-agency.controller.ts'), 'utf8');
  assert.ok(src.includes('export const deleteAgency'), 'expected deleteAgency export');
  assert.ok(
    src.includes('User.countDocuments({ agencyId: agencyOid, role: BD_ROLE_QUERY })'),
    'expected BD count guard'
  );
  assert.ok(
    src.includes("Withdrawal.countDocuments({ staffUserId: agencyOid, status: 'pending' })"),
    'expected pending staff withdrawal guard'
  );
  assert.ok(src.includes('staffCoinsBalance'), 'expected staff wallet balance guard');
  assert.ok(src.includes('upsertDeletedIdentities'), 'expected deleted-identity upsert before delete');
  assert.ok(src.includes("'agency_deleted'"), 'expected agency_deleted audit event');
});

test('createAgency must block deleted identities and require phone/place', () => {
  const src = readFileSync(join(__dirname, 'admin-agency.controller.ts'), 'utf8');
  assert.ok(src.includes('checkDeletedStatus'), 'expected checkDeletedStatus on create');
  assert.ok(src.includes('Phone number is required'), 'expected phone required');
  assert.ok(src.includes('Place is required'), 'expected place required');
  assert.ok(src.includes('agencyPlace'), 'expected agencyPlace field usage');
});

test('assertAgent must reject BD when parent agency row is missing or not agency role', () => {
  const src = readFileSync(join(__dirname, '../../middlewares/staff.middleware.ts'), 'utf8');
  assert.ok(src.includes("parent.role !== 'agency'"), 'expected parent agency role check');
  assert.ok(
    src.includes('Agency no longer exists — BD portal access suspended'),
    'expected stable BD error copy'
  );
});

test('agentLogin must block when parent agency missing', () => {
  const src = readFileSync(join(__dirname, '../auth/auth.controller.ts'), 'utf8');
  assert.ok(
    src.includes("parentAgency.role !== 'agency'"),
    'expected agentLogin parent agency role check'
  );
});

test('createAgencyBd must check deleted email status', () => {
  const src = readFileSync(join(__dirname, '../agency/agency-portal.controller.ts'), 'utf8');
  assert.ok(
    src.includes('checkDeletedStatus({ email, phone: null })'),
    'expected createAgencyBd deleted-identity check'
  );
});

test('createAgent must check deleted email status', () => {
  const src = readFileSync(join(__dirname, 'admin-agent.controller.ts'), 'utf8');
  assert.ok(
    src.includes('checkDeletedStatus({ email, phone: null })'),
    'expected createAgent deleted-identity check'
  );
});
