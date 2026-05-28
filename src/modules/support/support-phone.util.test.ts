import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSupportContactPhone } from './support-phone.util';

test('validateSupportContactPhone accepts E.164 numbers', () => {
  assert.equal(validateSupportContactPhone('+919876543210'), '+919876543210');
  assert.equal(validateSupportContactPhone('  +14155552671 '), '+14155552671');
});

test('validateSupportContactPhone rejects missing plus', () => {
  assert.throws(
    () => validateSupportContactPhone('919876543210'),
    /country code/i,
  );
});

test('validateSupportContactPhone rejects too few digits', () => {
  assert.throws(() => validateSupportContactPhone('+12345'), /10 digits/i);
});

test('validateSupportContactPhone rejects non-string', () => {
  assert.throws(() => validateSupportContactPhone(null), /required/i);
});
