import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getFreeCallDurationSeconds,
  getWelcomeIntroCallCreditsGrant,
  isFreeCallEnabled,
  validateFreeCallConfig,
} from './free-call.config';

test('free call config exposes allowed duration values', () => {
  assert.equal(typeof isFreeCallEnabled(), 'boolean');
  assert.ok([15, 30, 45].includes(getFreeCallDurationSeconds()));
  assert.ok(getWelcomeIntroCallCreditsGrant() >= 0);
});

test('free call config validates duration env', () => {
  const prevDuration = process.env.FREE_CALL_DURATION_SECONDS;
  try {
    process.env.FREE_CALL_DURATION_SECONDS = '99';
    assert.throws(
      () => validateFreeCallConfig(),
      /FREE_CALL_DURATION_SECONDS must be one of 15, 30, 45/,
    );
  } finally {
    if (prevDuration === undefined) delete process.env.FREE_CALL_DURATION_SECONDS;
    else process.env.FREE_CALL_DURATION_SECONDS = prevDuration;
  }
});

test('free call disabled returns zero grant', () => {
  const prevEnabled = process.env.FREE_CALL_ENABLED;
  try {
    process.env.FREE_CALL_ENABLED = 'false';
    assert.equal(isFreeCallEnabled(), false);
    assert.equal(getWelcomeIntroCallCreditsGrant(), 0);
  } finally {
    if (prevEnabled === undefined) delete process.env.FREE_CALL_ENABLED;
    else process.env.FREE_CALL_ENABLED = prevEnabled;
  }
});
