import { test } from 'node:test';
import assert from 'node:assert/strict';
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
