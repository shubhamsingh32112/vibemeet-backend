import test from 'node:test';
import assert from 'node:assert/strict';
import { __resetMomentsConfigForTests } from '../../../../config/moments';
import { followingWarmCacheKey, popularFeedCacheKey } from '../feed-fanout.service';

test('followingWarmCacheKey includes access mode and premium tier', () => {
  __resetMomentsConfigForTests();
  delete process.env.MOMENTS_ACCESS_MODE;
  assert.equal(
    followingWarmCacheKey('user123', false, 0, 20),
    'moments:following:warm:user123:paid:n:0:20',
  );
  assert.equal(
    followingWarmCacheKey('user123', true, 0, 20),
    'moments:following:warm:user123:paid:p:0:20',
  );
});

test('popularFeedCacheKey uses all tier in free access mode', () => {
  __resetMomentsConfigForTests();
  process.env.MOMENTS_ACCESS_MODE = 'free';
  assert.equal(
    popularFeedCacheKey('user123', false, '0', 20),
    'moments:feed:user123:free:all:0:20',
  );
  __resetMomentsConfigForTests();
  delete process.env.MOMENTS_ACCESS_MODE;
});

import { orderMomentsByIds } from '../feed-fanout.service';

test('orderMomentsByIds preserves cache order', () => {
  const moments = [
    { _id: { toString: () => 'b' } },
    { _id: { toString: () => 'a' } },
    { _id: { toString: () => 'c' } },
  ] as Array<{ _id: { toString: () => string } }>;
  const ordered = orderMomentsByIds(moments, ['a', 'c', 'b']);
  assert.deepEqual(ordered.map((m) => m._id.toString()), ['a', 'c', 'b']);
});
