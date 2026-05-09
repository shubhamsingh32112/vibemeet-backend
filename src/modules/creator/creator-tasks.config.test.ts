import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDailyPeriodBounds, getDailyPeriodBoundsForInstant } from './creator-tasks.config';

test('getDailyPeriodBoundsForInstant matches getDailyPeriodBounds at now', () => {
  const a = getDailyPeriodBounds();
  const b = getDailyPeriodBoundsForInstant(new Date());
  assert.equal(a.periodStart.getTime(), b.periodStart.getTime());
  assert.equal(a.periodEnd.getTime(), b.periodEnd.getTime());
});
