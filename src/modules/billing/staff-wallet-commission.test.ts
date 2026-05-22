import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

test('staff wallet controller merges commission meta into BD and agency wallet responses', () => {
  const src = readFileSync(join(__dirname, 'staff-wallet-portal.controller.ts'), 'utf8');
  assert.ok(src.includes('getStaffWalletCommissionMeta(staff)'));
  assert.ok(src.includes('getBdWallet'));
  assert.ok(src.includes('getAgencyWallet'));
});

test('getStaffWalletCommissionMeta formats bps as percent of host earnings', () => {
  const src = readFileSync(join(__dirname, 'staff-wallet-portal.service.ts'), 'utf8');
  const fnStart = src.indexOf('export async function getStaffWalletCommissionMeta');
  assert.ok(fnStart >= 0);
  const block = src.slice(fnStart, fnStart + 900);
  assert.ok(block.includes('rates.bdBps / 100'));
  assert.ok(block.includes('rates.agencyBps / 100'));
  assert.ok(block.includes('not deducted from creators'));
});
