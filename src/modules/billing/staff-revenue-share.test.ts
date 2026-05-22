import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeIndependentHostDisplayPercents,
  computeRevenueSplitDisplayPercents,
  computeStaffCutsFromHostEarnings,
} from './staff-revenue-share';

test('computeStaffCutsFromHostEarnings — 25 host coins, default bps', () => {
  const { bdCut, agencyCut } = computeStaffCutsFromHostEarnings(25, 500, 1500, true);
  assert.equal(bdCut, 1);
  assert.equal(agencyCut, 3);
});

test('computeStaffCutsFromHostEarnings — no BD when hasBd false', () => {
  const { bdCut, agencyCut } = computeStaffCutsFromHostEarnings(25, 500, 1500, false);
  assert.equal(bdCut, 0);
  assert.equal(agencyCut, 3);
});

test('computeStaffCutsFromHostEarnings — creator credit basis unchanged by staff', () => {
  const hostEarned = 25;
  const { bdCut, agencyCut } = computeStaffCutsFromHostEarnings(hostEarned, 500, 1500, true);
  assert.equal(hostEarned, 25);
  assert.equal(bdCut + agencyCut, 4);
  assert.equal(hostEarned + bdCut + agencyCut, 29);
});

test('computeRevenueSplitDisplayPercents — 25% host, 500/1500 bps', () => {
  const slices = computeRevenueSplitDisplayPercents(25, 500, 1500);
  const byKey = Object.fromEntries(slices.map((s) => [s.key, s.pct]));
  assert.equal(byKey.host, 25);
  assert.equal(byKey.bd, 1.25);
  assert.equal(byKey.agency, 3.75);
  assert.equal(byKey.platform, 70);
});

test('computeIndependentHostDisplayPercents — 25% host', () => {
  const slices = computeIndependentHostDisplayPercents(25);
  const byKey = Object.fromEntries(slices.map((s) => [s.key, s.pct]));
  assert.equal(byKey.host, 25);
  assert.equal(byKey.platform, 75);
});

test('creator earnings per minute at 25% share', () => {
  const share = 0.25;
  assert.equal(60 * share, 15);
  assert.equal(90 * share, 22.5);
  assert.equal(120 * share, 30);
});

/** Post-deploy smoke checklist (manual): one call, 100 coins user spend, agency+BD assigned. */
test('full split model — 100 coins user spend, 25% host, agency+BD', () => {
  const userSpend = 100;
  const hostSharePct = 25;
  const hostEarned = Math.floor((userSpend * hostSharePct) / 100);
  const { bdCut, agencyCut } = computeStaffCutsFromHostEarnings(hostEarned, 500, 1500, true);
  const platform = userSpend - hostEarned - bdCut - agencyCut;
  assert.equal(hostEarned, 25);
  assert.equal(bdCut, 1);
  assert.equal(agencyCut, 3);
  assert.equal(platform, 71);
  assert.equal(hostEarned + bdCut + agencyCut + platform, userSpend);
});
