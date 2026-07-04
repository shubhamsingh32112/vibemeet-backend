import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addIstDays,
  formatIstDateTime,
  istDateKey,
  istDayBounds,
  istHourKey,
  istRangeMatch,
  istRollingCalendarDays,
  istYesterdayKey,
  iterIstDateKeys,
} from './ist-time';

test('istDateKey maps Jul 5 00:30 IST to 2026-07-05', () => {
  // Jul 4 19:00 UTC = Jul 5 00:30 IST
  const d = new Date('2026-07-04T19:00:00.000Z');
  assert.equal(istDateKey(d), '2026-07-05');
});

test('istDateKey maps Jul 4 23:30 IST to 2026-07-04', () => {
  // Jul 4 18:00 UTC = Jul 4 23:30 IST
  const d = new Date('2026-07-04T18:00:00.000Z');
  assert.equal(istDateKey(d), '2026-07-04');
});

test('istDayBounds: Jul 4 18:30 UTC is start of IST Jul 5', () => {
  const { start, end } = istDayBounds('2026-07-05');
  assert.equal(start.toISOString(), '2026-07-04T18:30:00.000Z');
  assert.equal(end.toISOString(), '2026-07-05T18:30:00.000Z');
});

test('istDayBounds: Jul 4 00:00 IST boundary', () => {
  const { start } = istDayBounds('2026-07-04');
  assert.equal(start.toISOString(), '2026-07-03T18:30:00.000Z');
});

test('iterIstDateKeys is inclusive', () => {
  assert.deepEqual(iterIstDateKeys('2026-07-03', '2026-07-05'), [
    '2026-07-03',
    '2026-07-04',
    '2026-07-05',
  ]);
});

test('addIstDays and istYesterdayKey', () => {
  const now = new Date('2026-07-04T19:00:00.000Z'); // Jul 5 00:30 IST
  assert.equal(istDateKey(now), '2026-07-05');
  assert.equal(istYesterdayKey(now), '2026-07-04');
  assert.equal(addIstDays('2026-07-04', 1), '2026-07-05');
});

test('formatIstDateTime includes IST suffix', () => {
  const s = formatIstDateTime(new Date('2026-07-04T19:00:00.000Z'));
  assert.ok(s.endsWith(' IST'));
});

test('istHourKey matches mongo hour bucket format', () => {
  const d = new Date('2026-07-04T19:00:00.000Z');
  assert.equal(istHourKey(d).startsWith('2026-07-05'), true);
});

test('istRangeMatch is half-open [from, to)', () => {
  const from = new Date('2026-07-04T18:30:00.000Z');
  const to = new Date('2026-07-05T18:30:00.000Z');
  assert.deepEqual(istRangeMatch(from, to), { $gte: from, $lt: to });
  assert.ok(!('$lte' in istRangeMatch(from, to)));
});

test('istRollingCalendarDays aliases istLookbackCalendarDays', () => {
  const now = new Date('2026-07-04T19:00:00.000Z');
  const rolling = istRollingCalendarDays(7, now);
  assert.equal(rolling.from.toISOString(), istDayBounds(addIstDays('2026-07-05', -6)).start.toISOString());
  assert.equal(rolling.to.toISOString(), now.toISOString());
});
