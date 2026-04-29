import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('creator routes register /feed and /uids before parameterized :id', () => {
  const src = readFileSync(join(__dirname, 'creator.routes.ts'), 'utf8');
  const idxFeed = src.indexOf("router.get('/feed'");
  const idxUids = src.indexOf("router.get('/uids'");
  const idxId = src.indexOf("router.get('/:id'");
  assert.ok(idxFeed > 0 && idxUids > 0 && idxId > 0);
  assert.ok(idxFeed < idxId && idxUids < idxId);
});

test('GET /creator root returns 410 gone handler', () => {
  const src = readFileSync(join(__dirname, 'creator.controller.ts'), 'utf8');
  assert.ok(src.includes('getCreatorCatalogGone'));
  assert.ok(src.includes('.status(410)'));
});

test('getCreatorFeed must not call resolveGalleryImageUrlsForApi', () => {
  const src = readFileSync(join(__dirname, 'creator.controller.ts'), 'utf8');
  const start = src.indexOf('export const getCreatorFeed');
  const end = src.indexOf('export const getCreatorFirebaseUids');
  assert.ok(start > 0 && end > start);
  const block = src.slice(start, end);
  assert.ok(!block.includes('resolveGalleryImageUrlsForApi'));
});

test('getCreatorFeed enforces deterministic sort by createdAt desc', () => {
  const src = readFileSync(join(__dirname, 'creator.controller.ts'), 'utf8');
  const start = src.indexOf('export const getCreatorFeed');
  const end = src.indexOf('export const getCreatorFirebaseUids');
  assert.ok(start > 0 && end > start);
  const block = src.slice(start, end);
  assert.ok(block.includes('.sort({ createdAt: -1 })'));
});

test('creator UID fallback join is env-gated for shadow/cutover', () => {
  const src = readFileSync(join(__dirname, 'creator.controller.ts'), 'utf8');
  assert.ok(src.includes("ENABLE_CREATOR_UID_FALLBACK_JOIN"));
});

test('getCreatorById uses optional DISABLE_GALLERY_REPAIR_ON_READ', () => {
  const src = readFileSync(join(__dirname, 'creator.controller.ts'), 'utf8');
  assert.ok(src.includes('DISABLE_GALLERY_REPAIR_ON_READ'));
});

test('redis config defines creator feed and uids cache keys', () => {
  const src = readFileSync(join(__dirname, '../../config/redis.ts'), 'utf8');
  assert.ok(src.includes('CREATOR_FEED_PREFIX'));
  assert.ok(src.includes('CREATOR_UIDS_CACHE_KEY'));
  assert.ok(src.includes('invalidateCreatorCatalogCaches'));
});
