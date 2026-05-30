import assert from 'node:assert/strict';
import { test } from 'node:test';
import { billingInstanceIdsMatch } from './billing-instance-id';

test('billingInstanceIdsMatch accepts legacy pid-only session ids', () => {
  assert.equal(billingInstanceIdsMatch('41', '519c628eeef8:41'), true);
  assert.equal(billingInstanceIdsMatch('519c628eeef8:41', '41'), true);
});

test('billingInstanceIdsMatch rejects different workers', () => {
  assert.equal(billingInstanceIdsMatch('519c628eeef8:41', '519c628eeef8:42'), false);
  assert.equal(billingInstanceIdsMatch('host-a:41', 'host-b:41'), false);
});

test('billingInstanceIdsMatch accepts exact matches', () => {
  assert.equal(billingInstanceIdsMatch('519c628eeef8:41', '519c628eeef8:41'), true);
  assert.equal(billingInstanceIdsMatch('custom-instance', 'custom-instance'), true);
});
