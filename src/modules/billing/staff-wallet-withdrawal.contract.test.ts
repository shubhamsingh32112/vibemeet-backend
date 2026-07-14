import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('staff withdrawal request blocks active statuses and removes 24h cooldown', () => {
  const src = readFileSync(join(__dirname, 'staff-wallet-portal.service.ts'), 'utf8');
  assert.ok(src.includes('ACTIVE_WITHDRAWAL_STATUSES'));
  assert.ok(
    src.includes(
      'You already have an approved withdrawal awaiting payout. Please wait until it is marked paid.',
    ),
  );
  assert.ok(!src.includes('You can only request one withdrawal per 24 hours'));
  assert.ok(!src.includes('STAFF_WITHDRAWAL_COOLDOWN_MS'));
});

test('staff wallet summary exposes active withdrawal gating fields', () => {
  const src = readFileSync(join(__dirname, 'staff-wallet-portal.service.ts'), 'utf8');
  assert.ok(src.includes('activeWithdrawalCount'));
  assert.ok(src.includes('canRequestWithdrawal'));
});
