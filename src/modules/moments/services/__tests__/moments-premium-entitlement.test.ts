import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { __resetMomentsConfigForTests } from '../../../../config/moments';
import { isPreviewRowVisible } from '../free-preview.service';
import { resolveMomentAccess } from '../entitlement.service';
import { toFeedDTO } from '../../dto/moment.dto';
import type { PresentationDTO } from '../../dto/moment.dto';

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
  test('CREATOR when creator role without subscription', async () => {
    const result = await resolveMomentAccess('user1', 'moment1', {
      isCreatorRole: true,
    });
    assert.deepEqual(result, { allowed: true, reason: 'CREATOR' });
  });

  test('ADMIN when staff admin', async () => {
    const result = await resolveMomentAccess('user1', 'moment1', {
      isStaffAdmin: true,
    });
    assert.deepEqual(result, { allowed: true, reason: 'ADMIN' });
  });

  test('OWNER when creator owner', async () => {
    const result = await resolveMomentAccess('user1', 'moment1', {
      isCreatorOwner: true,
    });
    assert.deepEqual(result, { allowed: true, reason: 'OWNER' });
  });

  test('VIP on PUBLIC tier when VIP active', async () => {
    const result = await resolveMomentAccess('user1', 'moment1', {
      visibilityTier: 'PUBLIC',
      __testVipActive: true,
    });
    assert.deepEqual(result, { allowed: true, reason: 'VIP' });
  });

  test('VIP on VIP tier when VIP active', async () => {
    const result = await resolveMomentAccess('user1', 'moment1', {
      visibilityTier: 'VIP',
      __testVipActive: true,
    });
    assert.deepEqual(result, { allowed: true, reason: 'VIP' });
  });

  test('PREMIUM on PUBLIC tier when premium active', async () => {
    const result = await resolveMomentAccess('user1', 'moment1', {
      visibilityTier: 'PUBLIC',
      __testPremiumActive: true,
    });
    assert.deepEqual(result, { allowed: true, reason: 'PREMIUM' });
  });

  test('VIP_ONLY on VIP tier when premium but not VIP', async () => {
    const result = await resolveMomentAccess('user1', 'moment1', {
      visibilityTier: 'VIP',
      __testPremiumActive: true,
      __testVipActive: false,
    });
    assert.deepEqual(result, { allowed: false, reason: 'VIP_ONLY' });
  });

  test('VIP_ONLY on VIP tier when no subscription', async () => {
    __resetMomentsConfigForTests();
    delete process.env.USE_MOMENTS;
    const result = await resolveMomentAccess('user1', 'moment1', {
      visibilityTier: 'VIP',
    });
    assert.deepEqual(result, { allowed: false, reason: 'VIP_ONLY' });
  });

  test('PREVIEW when preview moment on PUBLIC tier', async () => {
    __resetMomentsConfigForTests();
    delete process.env.USE_MOMENTS;
    const result = await resolveMomentAccess('user1', 'moment1', {
      visibilityTier: 'PUBLIC',
      isPreviewMoment: true,
    });
    assert.deepEqual(result, { allowed: true, reason: 'PREVIEW' });
  });

  test('DENIED when no access on PUBLIC tier', async () => {
    __resetMomentsConfigForTests();
    delete process.env.USE_MOMENTS;
    const result = await resolveMomentAccess('user1', 'moment1', {
      visibilityTier: 'PUBLIC',
    });
    assert.deepEqual(result, { allowed: false, reason: 'DENIED' });
  });

  test('DENIED when no user', async () => {
    const result = await resolveMomentAccess(null, 'moment1', {
      isPreviewMoment: true,
    });
    assert.deepEqual(result, { allowed: false, reason: 'DENIED' });
  });
});

describe('consumer feed DTO', () => {
  test('does not expose visibilityTier', () => {
    const presentation = {
      id: 'm1',
      creatorId: 'c1',
      creatorName: 'Creator',
      media: {
        mediaType: 'image' as const,
        thumbnailUrl: 'https://example.com/t.jpg',
        locked: true,
        processingStatus: 'ready' as const,
      },
      createdAt: new Date().toISOString(),
      locked: true,
      isPreview: false,
      accessReason: 'VIP_ONLY' as const,
    } satisfies PresentationDTO;
    const feed = toFeedDTO(presentation);
    assert.equal(feed.locked, true);
    assert.equal(feed.accessReason, 'VIP_ONLY');
    assert.equal('visibilityTier' in feed, false);
  });
});
