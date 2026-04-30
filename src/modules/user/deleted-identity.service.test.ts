import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDeletedStatus,
  normalizeEmail,
  normalizePhone,
  upsertDeletedIdentities,
} from './deleted-identity.service';

test('normalizeEmail trims and lowercases', () => {
  assert.equal(normalizeEmail('  Foo@Example.COM '), 'foo@example.com');
});

test('normalizePhone trims only (expects E.164 from Firebase)', () => {
  assert.equal(normalizePhone('  +919876543210 '), '+919876543210');
});

test('checkDeletedStatus returns false when no identities provided (no DB hit)', async () => {
  const r = await checkDeletedStatus({ email: null, phone: null });
  assert.equal(r.isDeleted, false);
  assert.deepEqual(r.matchedTypes, []);
});

test('upsertDeletedIdentities is a no-op when no identities provided', async () => {
  await upsertDeletedIdentities({ email: null, phone: null });
});

