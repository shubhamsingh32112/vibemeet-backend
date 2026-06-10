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

test('getCreatorFeed must not call any per-row gallery URL repair helper', () => {
  // Cloudflare-Images derives URLs deterministically from imageId at serialize
  // time, so the feed path must NOT trigger per-row resolution work.
  const src = readFileSync(join(__dirname, 'creator.controller.ts'), 'utf8');
  const start = src.indexOf('export const getCreatorFeed');
  const end = src.indexOf('export const getCreatorFirebaseUids');
  assert.ok(start > 0 && end > start);
  const block = src.slice(start, end);
  assert.ok(!block.includes('resolveGalleryImageUrlsForApi'));
  assert.ok(!block.includes('buildPublicGalleryDownloadUrl'));
  assert.ok(!block.includes('tryBuildPublicGalleryDownloadUrl'));
});

test('getCreatorFeed enforces deterministic sort by createdAt desc', () => {
  const src = readFileSync(join(__dirname, 'creator.controller.ts'), 'utf8');
  const start = src.indexOf('export const getCreatorFeed');
  const end = src.indexOf('export const getCreatorFirebaseUids');
  assert.ok(start > 0 && end > start);
  const block = src.slice(start, end);
  assert.ok(block.includes('.sort({ createdAt: -1 })'));
});

test('getCreatorFeed supports sort=availability with presence rank', () => {
  const src = readFileSync(join(__dirname, 'creator.controller.ts'), 'utf8');
  const start = src.indexOf('export const getCreatorFeed');
  const end = src.indexOf('export const getCreatorFirebaseUids');
  assert.ok(start > 0 && end > start);
  const block = src.slice(start, end);
  assert.ok(block.includes("parseCreatorFeedSort(req.query.sort)"));
  assert.ok(block.includes("feedSort === 'availability'"));
  assert.ok(block.includes('availabilityRank'));
  assert.ok(block.includes('getBatchCreatorPresence'));
});

test('creator UID fallback join is env-gated for shadow/cutover', () => {
  const src = readFileSync(join(__dirname, 'creator.controller.ts'), 'utf8');
  assert.ok(src.includes("ENABLE_CREATOR_UID_FALLBACK_JOIN"));
});


test('redis config defines creator feed and uids cache keys', () => {
  const src = readFileSync(join(__dirname, '../../config/redis.ts'), 'utf8');
  assert.ok(src.includes('CREATOR_FEED_PREFIX'));
  assert.ok(src.includes('CREATOR_UIDS_CACHE_KEY'));
  assert.ok(src.includes('CREATOR_UIDS_SET_KEY'));
  assert.ok(src.includes('invalidateCreatorCatalogCaches'));
});

test('getCreatorFirebaseUids uses streaming cache service not bare Creator.find({})', () => {
  const src = readFileSync(join(__dirname, 'creator.controller.ts'), 'utf8');
  const start = src.indexOf('export const getCreatorFirebaseUids');
  const end = src.indexOf('export const getCreatorById');
  assert.ok(start > 0 && end > start);
  const block = src.slice(start, end);
  assert.ok(block.includes('getCreatorFirebaseUidsCached'));
  assert.ok(!block.includes('Creator.find({})'));
});

test('getCreatorFeed serves unscoped consumer catalog (not agency-filtered)', () => {
  const src = readFileSync(join(__dirname, 'creator.controller.ts'), 'utf8');
  const start = src.indexOf('export const getCreatorFeed');
  const end = src.indexOf('export const getCreatorFirebaseUids');
  assert.ok(start > 0 && end > start);
  const block = src.slice(start, end);
  assert.ok(block.includes('Creator.find({})'));
  assert.ok(!block.includes('assignedAgencyId'));
  assert.ok(!block.includes('assignedAgentId'));
});

test('getCreatorFeed blocks portal roles but not regular users', () => {
  const src = readFileSync(join(__dirname, 'creator.controller.ts'), 'utf8');
  const start = src.indexOf('export const getCreatorFeed');
  const end = src.indexOf('export const getCreatorFirebaseUids');
  assert.ok(start > 0 && end > start);
  const block = src.slice(start, end);
  assert.ok(block.includes("currentUser?.role === 'creator'"));
  assert.ok(block.includes('isBdRole(currentUser?.role)'));
  assert.ok(block.includes('isAgencyRole(currentUser?.role)'));
  assert.ok(block.includes("currentUser.role === 'user'"));
});

test('getCreatorFeed response includes fields required by mobile CreatorModel', () => {
  const src = readFileSync(join(__dirname, 'creator.controller.ts'), 'utf8');
  const start = src.indexOf('export const getCreatorFeed');
  const end = src.indexOf('export const getCreatorFirebaseUids');
  assert.ok(start > 0 && end > start);
  const block = src.slice(start, end);
  assert.ok(block.includes('id: creator._id.toString()'));
  assert.ok(block.includes('name: creator.name'));
  assert.ok(block.includes('price: creator.price'));
  assert.ok(block.includes('creators: creatorsOut'));
  assert.ok(block.includes('pagination:'));
  assert.ok(block.includes('CREATOR_FEED_CACHE_VERSION'));
});

test('creator feed cache key includes sort mode', () => {
  const src = readFileSync(join(__dirname, '../../config/redis.ts'), 'utf8');
  assert.ok(src.includes('CreatorFeedSortMode'));
  assert.ok(src.includes(':s:${sort}'));
});

test('getCreatorFeed records availability sort feed metrics', () => {
  const src = readFileSync(join(__dirname, 'creator.controller.ts'), 'utf8');
  const start = src.indexOf('export const getCreatorFeed');
  const end = src.indexOf('export const getCreatorFirebaseUids');
  const block = src.slice(start, end);
  assert.ok(block.includes('recordFeedMetric'));
  assert.ok(block.includes('creator_feed_availability_sort_ms'));
  assert.ok(block.includes('creator.feed.availability_sort_large_catalog'));
});

test('presence service emits creator_status_events_sent metric', () => {
  const src = readFileSync(
    join(__dirname, '../availability/presence.service.ts'),
    'utf8',
  );
  assert.ok(src.includes('creator_status_events_sent'));
  assert.ok(src.includes("nextRecord.state === 'on_call'"));
});

test('redis config defines creator feed rank key and invalidation', () => {
  const src = readFileSync(join(__dirname, '../../config/redis.ts'), 'utf8');
  assert.ok(src.includes('CREATOR_FEED_RANK_KEY'));
  assert.ok(src.includes('creator:feed:rank:v1'));
});

test('getCreatorFeed availability sort uses rank ZSET when enabled with legacy fallback', () => {
  const src = readFileSync(join(__dirname, 'creator.controller.ts'), 'utf8');
  const start = src.indexOf('export const getCreatorFeed');
  const end = src.indexOf('export const getCreatorFirebaseUids');
  const block = src.slice(start, end);
  assert.ok(block.includes('getAvailabilityFeedPageFromRank'));
  assert.ok(block.includes('buildLegacyAvailabilityPage'));
  assert.ok(block.includes('CREATOR_FEED_RANK_SHADOW'));
});

test('creator feed rank service documents Redis ownership and uses catalog cap', () => {
  const src = readFileSync(join(__dirname, 'creator-feed-rank.service.ts'), 'utf8');
  assert.ok(src.includes('creator:feed:rank:v1'));
  assert.ok(src.includes('readCreatorFeedAvailabilityMaxCatalog'));
  assert.ok(src.includes('rebuildCreatorFeedRankIndex'));
  assert.ok(src.includes('removeCreatorFromFeedRank'));
});

test('creator create/delete syncs UID cache and feed rank membership', () => {
  const src = readFileSync(join(__dirname, 'creator.controller.ts'), 'utf8');
  assert.ok(src.includes('addCreatorFirebaseUidToCache'));
  assert.ok(src.includes('removeCreatorFirebaseUidFromCache'));
  assert.ok(src.includes('removeCreatorFromFeedRank'));
});
