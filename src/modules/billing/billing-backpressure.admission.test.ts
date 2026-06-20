import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isNewCallAdmissionBlocked,
  resetBackpressureStateForTests,
  updateBackpressureStage,
} from './billing-backpressure';

test('admission hysteresis: one severe sample does not block new calls', () => {
  resetBackpressureStateForTests();
  updateBackpressureStage({ queueLagMs: 20_000 });
  assert.equal(isNewCallAdmissionBlocked(), false);
});

test('admission hysteresis: consecutive severe samples block new calls', () => {
  resetBackpressureStateForTests();
  updateBackpressureStage({ queueLagMs: 20_000 });
  updateBackpressureStage({ queueLagMs: 20_000 });
  assert.equal(isNewCallAdmissionBlocked(), true);
});

test('admission hysteresis: severe sample reset clears block', () => {
  resetBackpressureStateForTests();
  updateBackpressureStage({ queueLagMs: 20_000 });
  updateBackpressureStage({ queueLagMs: 20_000 });
  assert.equal(isNewCallAdmissionBlocked(), true);
  updateBackpressureStage({ queueLagMs: 0 });
  assert.equal(isNewCallAdmissionBlocked(), false);
});
