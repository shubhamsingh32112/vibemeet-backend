import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const servicesDir = join(__dirname, 'services');

function readService(name: string): string {
  return readFileSync(join(servicesDir, name), 'utf8');
}

test('feed service orders only — no premium branch or locked field', () => {
  const src = readService('moments-feed.service.ts');
  assert.ok(!src.includes('locked:'));
  assert.ok(!src.includes('resolveMomentAccess'));
  assert.ok(!src.includes('isPremium'));
  assert.ok(src.includes('previewEndIndex'));
  assert.ok(src.includes("section: 'preview'"));
});

test('audience layer strips preview for premium users', () => {
  const src = readFileSync(
    join(__dirname, 'services/feed-audience.service.ts'),
    'utf8',
  );
  assert.ok(src.includes('applyAudienceToFeedOrdering'));
  assert.ok(src.includes("section !== 'preview'"));
});

test('presentation service calls entitlement for every feed item', () => {
  const src = readService('moment-presentation.service.ts');
  assert.ok(src.includes('resolveMomentAccess'));
  assert.ok(src.includes('accessReason'));
  assert.ok(src.includes('isPreview'));
  assert.ok(!src.includes('accessType'));
  assert.ok(!src.includes('priceCoins'));
});

test('entitlement service uses premium + preview reasons only', () => {
  const src = readService('entitlement.service.ts');
  assert.ok(src.includes("'OWNER'"));
  assert.ok(src.includes("'PREMIUM'"));
  assert.ok(src.includes("'PREVIEW'"));
  assert.ok(src.includes("'DENIED'"));
  assert.ok(!src.includes('MomentPurchase'));
  assert.ok(!src.includes('accessType'));
});

test('free preview reorder throws version conflict error', () => {
  const src = readService('free-preview.service.ts');
  assert.ok(src.includes('PreviewListVersionConflictError'));
  assert.ok(src.includes('expectedVersion'));
  assert.ok(src.includes('invalidatePreviewAndFeedCaches'));
});

test('moments controller returns sections in feed payload', () => {
  const src = readFileSync(join(__dirname, 'controllers/moments.controller.ts'), 'utf8');
  assert.ok(src.includes('sections: ordering.sections'));
  assert.ok(src.includes('buildPopularFeedOrdering'));
  assert.ok(src.includes('presentationFromFeedOrderingItem'));
});

test('admin free preview reorder returns 409 on version conflict', () => {
  const src = readFileSync(
    join(__dirname, '../admin/admin-moments-free-preview.controller.ts'),
    'utf8',
  );
  assert.ok(src.includes('PreviewListVersionConflictError'));
  assert.ok(src.includes('409'));
  assert.ok(src.includes('expectedVersion'));
});

test('creator moment schema has no accessType or priceCoins', () => {
  const src = readFileSync(join(__dirname, 'models/creator-moment.model.ts'), 'utf8');
  assert.ok(!src.includes('accessType'));
  assert.ok(!src.includes('priceCoins'));
});
