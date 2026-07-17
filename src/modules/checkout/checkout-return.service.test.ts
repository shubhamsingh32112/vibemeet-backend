import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCheckoutOrigin, validateReturnTo } from './checkout-return.service';

test('validateReturnTo preserves a safe relative path with query and hash', () => {
  assert.equal(
    validateReturnTo('/moments/creator?id=abc#comments'),
    '/moments/creator?id=abc#comments',
  );
});

test('validateReturnTo rejects cross-origin and checkout-loop inputs', () => {
  const invalid = [
    'https://evil.example/path',
    '//evil.example/path',
    '/\\evil.example',
    '/%2f%2fevil.example',
    '/%252f%252fevil.example',
    '/payment/return?checkoutId=x',
    '/wallet-checkout',
    '/path\u0000',
  ];
  for (const value of invalid) {
    assert.throws(() => validateReturnTo(value), /Invalid returnTo/);
  }
});

test('legacy initiators default to app origin', () => {
  assert.equal(resolveCheckoutOrigin(undefined), 'app');
  assert.equal(resolveCheckoutOrigin('web'), 'web');
  assert.throws(() => resolveCheckoutOrigin('other'), /Invalid checkoutOrigin/);
});
