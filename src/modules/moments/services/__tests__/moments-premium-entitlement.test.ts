import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { __resetMomentsConfigForTests } from '../../../../config/moments';
import { isPreviewRowVisible } from '../free-preview.service';
import { resolveMomentAccess } from '../entitlement.service';

describe('isPreviewRowVisible', () => {
  const base = {
    enabled: true,
    startsAt: null,
    endsAt: null,
  } as { enabled: boolean; startsAt: Date | null; endsAt: Date | null };

  test('hidden when disabled', () => {
    assert.equal(isPreviewRowVisible({ ...base, enabled: false }), false);
  });

  test('hidden when startsAt in future', () => {
    const future = new Date(Date.now() + 60_000);
    assert.equal(isPreviewRowVisible({ ...base, startsAt: future }), false);
  });

  test('hidden when endsAt in past', () => {
    const past = new Date(Date.now() - 60_000);
    assert.equal(isPreviewRowVisible({ ...base, endsAt: past }), false);
  });

  test('visible when enabled and in window', () => {
    assert.equal(isPreviewRowVisible(base), true);
  });
});

describe('resolveMomentAccess', () => {
  test('OWNER when creator owner', async () => {
    const result = await resolveMomentAccess('user1', 'moment1', {
      isCreatorOwner: true,
    });
    assert.deepEqual(result, { allowed: true, reason: 'OWNER' });
  });

  test('PREVIEW when preview moment', async () => {
    __resetMomentsConfigForTests();
    delete process.env.USE_MOMENTS;
    const result = await resolveMomentAccess('user1', 'moment1', {
      isPreviewMoment: true,
    });
    assert.deepEqual(result, { allowed: true, reason: 'PREVIEW' });
  });

  test('DENIED when no access', async () => {
    __resetMomentsConfigForTests();
    delete process.env.USE_MOMENTS;
    const result = await resolveMomentAccess('user1', 'moment1', {});
    assert.deepEqual(result, { allowed: false, reason: 'DENIED' });
  });

  test('DENIED when no user', async () => {
    const result = await resolveMomentAccess(null, 'moment1', {
      isPreviewMoment: true,
    });
    assert.deepEqual(result, { allowed: false, reason: 'DENIED' });
  });
});
