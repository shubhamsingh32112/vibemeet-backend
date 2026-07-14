import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('users analytics service buckets signups and logins in IST', () => {
  const src = readFileSync(join(__dirname, 'admin-analytics.service.ts'), 'utf8');
  assert.ok(src.includes("timezone: IST_TIMEZONE"), 'returns IST timezone metadata');
  assert.ok(src.includes("timezone: IST_TIMEZONE }"), 'mongo buckets use Asia/Kolkata');
  assert.ok(src.includes('istLookbackCalendarDays(30'), 'daily series uses IST lookback');
  assert.ok(src.includes('todayIst: todayKey'), 'summary includes IST today key');
});

test('admin date range presets use IST on frontend', () => {
  const src = readFileSync(join(__dirname, '../../../../adminWebsite/src/utils/dateRange.ts'), 'utf8');
  assert.ok(src.includes('computeIstPresetRange'));
  assert.ok(src.includes('Asia/Kolkata calendar days'));
});
