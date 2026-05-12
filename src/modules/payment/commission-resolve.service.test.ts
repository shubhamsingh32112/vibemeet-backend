import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMISSION_PROFILE_RESOLUTION_SORT } from './commission-resolve.service';

test('COMMISSION_PROFILE_RESOLUTION_SORT matches documented tie-break order', () => {
  assert.deepEqual(COMMISSION_PROFILE_RESOLUTION_SORT, {
    priority: -1,
    validFrom: -1,
    createdAt: -1,
    _id: -1,
  });
});
