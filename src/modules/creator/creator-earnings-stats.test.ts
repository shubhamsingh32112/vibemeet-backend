import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAvgEarningsPerMinute,
  computeEarnDeviationPct,
  expectedCreatorEarningsPerMinute,
} from './creator-earnings-stats';

test('expectedCreatorEarningsPerMinute uses share of price', () => {
  assert.equal(expectedCreatorEarningsPerMinute(60), 15);
});

test('computeAvgEarningsPerMinute matches creator dashboard formula', () => {
  assert.equal(computeAvgEarningsPerMinute(100, 600), 10);
});

test('computeEarnDeviationPct compares avg to expected rate not full price', () => {
  const price = 60;
  const expected = expectedCreatorEarningsPerMinute(price);
  const avg = 10;
  const dev = computeEarnDeviationPct(avg, expected);
  assert.equal(dev, -33.33);
  const wrongBaseline = computeEarnDeviationPct(avg, price);
  assert.equal(wrongBaseline, -83.33);
});
