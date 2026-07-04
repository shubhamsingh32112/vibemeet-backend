import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('leaderboard period windows use IST lookback', () => {
  const src = readFileSync(join(__dirname, 'admin-leaderboards.service.ts'), 'utf8');
  assert.ok(src.includes('istLookbackCalendarDays'));
  assert.ok(!src.includes('setUTCHours(0, 0, 0, 0)'));
});

test('revenue split uses IST calendar lookback', () => {
  const src = readFileSync(join(__dirname, 'admin-revenue-split.controller.ts'), 'utf8');
  assert.ok(src.includes('istLookbackCalendarDays'));
  assert.ok(src.includes("timezone: IST_TIMEZONE"));
});

test('admin controller daysAgo uses IST day bounds', () => {
  const src = readFileSync(join(__dirname, 'admin.controller.ts'), 'utf8');
  assert.ok(src.includes('istDayBounds(addIstDays(todayKey, -days))'));
  assert.ok(!src.includes('d.setHours(0, 0, 0, 0)'));
});
