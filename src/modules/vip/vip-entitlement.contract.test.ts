import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..', '..');

test('vip entitlement service exports required helpers', () => {
  const src = fs.readFileSync(
    path.join(root, 'modules/vip/vip-entitlement.service.ts'),
    'utf8',
  );
  assert.ok(src.includes('export async function isVipActive'));
  assert.ok(src.includes('export async function getVipStatus'));
  assert.ok(src.includes('export async function getRemainingFreeMoments'));
  assert.ok(src.includes('export async function applyRechargeDiscount'));
  assert.ok(src.includes('export async function applyMomentDiscount'));
  assert.ok(src.includes('export async function resolveMomentPriceForUser'));
});

test('vip purchase finalization is idempotent by order txn id', () => {
  const src = fs.readFileSync(
    path.join(root, 'modules/vip/vip-purchase-finalization.service.ts'),
    'utf8',
  );
  assert.ok(src.includes('alreadyProcessed'));
  assert.ok(src.includes('buildVipTxnId'));
  assert.ok(src.includes('vip_membership'));
});

test('chat pre-send bypasses billing for VIP users', () => {
  const src = fs.readFileSync(
    path.join(root, 'modules/chat/chat.controller.ts'),
    'utf8',
  );
  assert.ok(src.includes('isVipActive'));
  assert.ok(src.includes('isVipUnlimited'));
  assert.ok(src.includes('vip_unlimited'));
});

test('call lifecycle enqueues VIP callers on creator overlap', () => {
  const src = fs.readFileSync(
    path.join(root, 'modules/video/call-lifecycle.service.ts'),
    'utf8',
  );
  assert.ok(src.includes('enqueueVipCaller'));
  assert.ok(src.includes('creatorConflict'));
});

test('chat quota endpoint returns VIP unlimited branch', () => {
  const src = fs.readFileSync(
    path.join(root, 'modules/chat/chat.controller.ts'),
    'utf8',
  );
  assert.ok(src.includes('export const getMessageQuota'));
  assert.match(
    src,
    /getMessageQuota[\s\S]*isVipActive[\s\S]*isVipUnlimited:\s*true/,
  );
});

test('call finalization dequeues next VIP caller', () => {
  const src = fs.readFileSync(
    path.join(root, 'modules/video/call-finalization.service.ts'),
    'utf8',
  );
  assert.ok(src.includes('popNextQueuedCaller'));
  assert.ok(src.includes('vip:call:ready_to_ring'));
});
