import test from 'node:test';
import assert from 'node:assert/strict';
import { followingWarmCacheKey, orderMomentsByIds } from '../feed-fanout.service';

test('followingWarmCacheKey includes premium tier', () => {
  assert.equal(
    followingWarmCacheKey('user123', false, 0, 20),
    'moments:following:warm:user123:n:0:20',
  );
  assert.equal(
    followingWarmCacheKey('user123', true, 0, 20),
    'moments:following:warm:user123:p:0:20',
  );
});

test('orderMomentsByIds preserves cache order', () => {
  const moments = [
    { _id: { toString: () => 'b' } },
    { _id: { toString: () => 'a' } },
    { _id: { toString: () => 'c' } },
  ] as Array<{ _id: { toString: () => string } }>;
  const ordered = orderMomentsByIds(moments, ['a', 'c', 'b']);
  assert.deepEqual(ordered.map((m) => m._id.toString()), ['a', 'c', 'b']);
});
