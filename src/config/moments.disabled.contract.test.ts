import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MomentsDisabledError,
  assertMomentsEnabled,
  respondMomentsDisabled,
  __resetMomentsConfigForTests,
} from './moments';

test('assertMomentsEnabled throws MomentsDisabledError when USE_MOMENTS is not true', () => {
  const previous = process.env.USE_MOMENTS;
  process.env.USE_MOMENTS = 'false';
  __resetMomentsConfigForTests();
  try {
    assert.throws(() => assertMomentsEnabled(), MomentsDisabledError);
  } finally {
    process.env.USE_MOMENTS = previous;
    __resetMomentsConfigForTests();
  }
});

test('respondMomentsDisabled returns structured FEATURE_DISABLED payload', () => {
  const error = new MomentsDisabledError();
  let statusCode = 0;
  let body: Record<string, unknown> | null = null;
  const handled = respondMomentsDisabled(error, {
    status: (code: number) => ({
      json: (payload: unknown) => {
        statusCode = code;
        body = payload as Record<string, unknown>;
      },
    }),
  });
  assert.equal(handled, true);
  assert.equal(statusCode, 503);
  assert.equal(body?.code, 'FEATURE_DISABLED');
  assert.equal(body?.error, 'Moments is not available yet');
});
