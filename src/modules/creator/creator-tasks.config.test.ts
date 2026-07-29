import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getDailyPeriodBounds,
  getDailyPeriodBoundsForInstant,
  getWeeklyPeriodBounds,
  getWeeklyPeriodBoundsForInstant,
  legacyDailyPeriodStart,
  dailyPeriodStartsForLookup,
} from './creator-tasks.config';
import { istDayBounds } from '../../utils/ist-time';

test('daily period is IST calendar midnight to next midnight', () => {
  // 2026-07-29 15:30 IST = 10:00 UTC
  const when = new Date('2026-07-29T10:00:00.000Z');
  const { periodStart, periodEnd, resetsAt } = getDailyPeriodBoundsForInstant(when);
  const expected = istDayBounds('2026-07-29');
  assert.equal(periodStart.getTime(), expected.start.getTime());
  assert.equal(periodEnd.getTime(), expected.end.getTime());
  assert.equal(resetsAt.getTime(), expected.end.getTime());
});

test('getDailyPeriodBoundsForInstant matches getDailyPeriodBounds at now', () => {
  const a = getDailyPeriodBounds();
  const b = getDailyPeriodBoundsForInstant(new Date());
  assert.equal(a.periodStart.getTime(), b.periodStart.getTime());
  assert.equal(a.periodEnd.getTime(), b.periodEnd.getTime());
});

test('daily period just after IST midnight stays on that calendar day', () => {
  // 2026-07-29 00:00:01 IST = 2026-07-28 18:30:01 UTC
  const justAfter = new Date('2026-07-28T18:30:01.000Z');
  const { periodStart } = getDailyPeriodBoundsForInstant(justAfter);
  assert.equal(periodStart.getTime(), istDayBounds('2026-07-29').start.getTime());
});

test('legacy daily period start is prior 23:59 boundary', () => {
  const midnight = istDayBounds('2026-07-29').start;
  const legacy = legacyDailyPeriodStart(midnight);
  assert.equal(legacy.getTime(), midnight.getTime() - 60_000);
  assert.deepEqual(
    dailyPeriodStartsForLookup(midnight).map((d) => d.getTime()),
    [midnight.getTime(), legacy.getTime()]
  );
});

test('getWeeklyPeriodBoundsForInstant matches getWeeklyPeriodBounds at now', () => {
  const a = getWeeklyPeriodBounds();
  const b = getWeeklyPeriodBoundsForInstant(new Date());
  assert.equal(a.periodStart.getTime(), b.periodStart.getTime());
  assert.equal(a.periodEnd.getTime(), b.periodEnd.getTime());
});

test('weekly period starts Monday 00:00 IST and lasts 7 days', () => {
  // Wednesday 2026-07-29 15:00 IST
  const wed = new Date('2026-07-29T09:30:00.000Z');
  const { periodStart, periodEnd, resetsAt } = getWeeklyPeriodBoundsForInstant(wed);
  assert.equal(periodStart.getTime(), istDayBounds('2026-07-27').start.getTime()); // Mon 27 Jul
  assert.equal(periodEnd.getTime() - periodStart.getTime(), 7 * 24 * 60 * 60 * 1000);
  assert.equal(resetsAt.getTime(), periodEnd.getTime());
});

test('weekly period on Monday uses that Monday as start', () => {
  const mon = new Date('2026-07-26T18:30:00.000Z'); // Mon 27 Jul 00:00 IST
  const { periodStart } = getWeeklyPeriodBoundsForInstant(mon);
  assert.equal(periodStart.getTime(), istDayBounds('2026-07-27').start.getTime());
});

test('weekly period on Sunday still belongs to prior Monday', () => {
  // Sun 2 Aug 2026 22:00 IST = 16:30 UTC
  const sun = new Date('2026-08-02T16:30:00.000Z');
  const { periodStart, periodEnd } = getWeeklyPeriodBoundsForInstant(sun);
  assert.equal(periodStart.getTime(), istDayBounds('2026-07-27').start.getTime());
  assert.equal(periodEnd.getTime(), istDayBounds('2026-08-03').start.getTime());
});
