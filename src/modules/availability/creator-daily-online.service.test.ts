import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { allocateSecondsByPeriodStartMs } from './creator-daily-online.service';

test('allocateSecondsByPeriodStartMs returns empty for non-positive range', () => {
  assert.equal(allocateSecondsByPeriodStartMs(100, 100).size, 0);
  assert.equal(allocateSecondsByPeriodStartMs(200, 100).size, 0);
});

test('allocateSecondsByPeriodStartMs counts in-window slice', () => {
  const from = new Date(2026, 4, 8, 12, 0, 0).getTime();
  const to = from + 65_000;
  const m = allocateSecondsByPeriodStartMs(from, to);
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  assert.equal(total, 65);
});

test('getOnlineTodaySecondsLive delegates to batch helper', async () => {
  const servicePath = path.join(__dirname, 'creator-daily-online.service.ts');
  const src = await fs.readFile(servicePath, 'utf8');
  assert.ok(src.includes('export async function getBatchOnlineTodaySecondsLive'));
  assert.ok(src.includes('const map = await getBatchOnlineTodaySecondsLive([creatorFirebaseUid])'));
});
