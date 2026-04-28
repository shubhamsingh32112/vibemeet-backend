/**
 * Contract tests for admin creator-to-agent transfer wiring.
 * These are static checks to prevent regressions in routes/guards/audit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('admin routes must expose creator transfer endpoint', () => {
  const src = readFileSync(join(__dirname, 'admin.routes.ts'), 'utf8');
  assert.ok(
    src.includes("router.post('/creators/:id/transfer-agent', postAdminTransferCreatorToAgent)"),
    'expected admin.routes.ts to wire POST /creators/:id/transfer-agent'
  );
});

test('admin controller must enforce admin and write audit log', () => {
  const src = readFileSync(join(__dirname, 'admin.controller.ts'), 'utf8');
  assert.ok(
    src.includes('export const postAdminTransferCreatorToAgent'),
    'expected admin.controller.ts to export postAdminTransferCreatorToAgent'
  );
  assert.ok(
    src.includes('await assertAdmin(req, res)'),
    'expected transfer endpoint to enforce admin access'
  );
  assert.ok(
    src.includes("'CREATOR_TRANSFER_AGENT'"),
    'expected transfer endpoint to log CREATOR_TRANSFER_AGENT action'
  );
});

test('transfer service must update assignment + referral attribution + pending withdrawals', () => {
  const src = readFileSync(join(__dirname, 'creator-transfer.service.ts'), 'utf8');
  assert.ok(src.includes('creator.assignedAgentId'), 'expected service to update Creator.assignedAgentId');
  assert.ok(src.includes('user.referredBy'), 'expected service to update User.referredBy');
  assert.ok(src.includes('ReferralEdge'), 'expected service to upsert/update ReferralEdge');
  assert.ok(
    src.includes('Withdrawal.updateMany') && src.includes("status: 'pending'"),
    'expected service to reassign pending withdrawals'
  );
});

