import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  __resetCheckInConfigForTests,
  getDailyCheckInRewards,
  getDailyCheckInRewardForDay,
  getDailyCheckInReminderHourIst,
  isDailyCheckInEnabled,
} from './checkin.config';
import {
  buildRewardsGrid,
  dailyCheckInTransactionId,
} from './checkin.service';
import { isInsideReminderWindow } from './checkin-reminder.job';
import { istDateKey, istDayBounds } from '../../utils/ist-time';

describe('checkin.config', () => {
  beforeEach(() => {
    __resetCheckInConfigForTests();
    delete process.env.DAILY_CHECKIN_REWARDS;
    delete process.env.DAILY_CHECKIN_ENABLED;
    delete process.env.DAILY_CHECKIN_REMINDER_HOUR_IST;
  });

  test('default rewards match UI schedule', () => {
    assert.deepEqual(getDailyCheckInRewards(), [50, 80, 50, 50, 50, 50, 100]);
    assert.equal(getDailyCheckInRewardForDay(1), 50);
    assert.equal(getDailyCheckInRewardForDay(2), 80);
    assert.equal(getDailyCheckInRewardForDay(7), 100);
  });

  test('parses custom rewards from env', () => {
    process.env.DAILY_CHECKIN_REWARDS = '10,20,30,40,50,60,70';
    __resetCheckInConfigForTests();
    assert.deepEqual(getDailyCheckInRewards(), [10, 20, 30, 40, 50, 60, 70]);
  });

  test('falls back on invalid rewards env', () => {
    process.env.DAILY_CHECKIN_REWARDS = '1,2,3';
    __resetCheckInConfigForTests();
    assert.deepEqual(getDailyCheckInRewards(), [50, 80, 50, 50, 50, 50, 100]);
  });

  test('feature flag is opt-in', () => {
    assert.equal(isDailyCheckInEnabled(), false);
    process.env.DAILY_CHECKIN_ENABLED = 'true';
    assert.equal(isDailyCheckInEnabled(), true);
  });

  test('reminder hour defaults to 11', () => {
    assert.equal(getDailyCheckInReminderHourIst(), 11);
    process.env.DAILY_CHECKIN_REMINDER_HOUR_IST = '18';
    assert.equal(getDailyCheckInReminderHourIst(), 18);
  });
});

describe('dailyCheckInTransactionId', () => {
  test('is deterministic per user and IST date', () => {
    const id = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
    assert.equal(
      dailyCheckInTransactionId(id, '2026-08-01'),
      'daily_checkin_507f1f77bcf86cd799439011_2026-08-01'
    );
    assert.equal(
      dailyCheckInTransactionId(id, '2026-08-01'),
      dailyCheckInTransactionId(id.toString(), '2026-08-01')
    );
  });
});

describe('buildRewardsGrid', () => {
  const rewards = [50, 80, 50, 50, 50, 50, 100];

  test('fresh user: Day 1 is today', () => {
    const grid = buildRewardsGrid({
      nextDayIndex: 1,
      lastClaimDateKey: null,
      lastClaimedDayIndex: null,
      todayKey: '2026-08-01',
      rewards,
    });
    assert.equal(grid[0].status, 'today');
    assert.equal(grid[1].status, 'upcoming');
    assert.equal(grid[6].status, 'upcoming');
    assert.equal(grid[0].coins, 50);
  });

  test('after Day 1 claim same day: Day 1 claimed', () => {
    const grid = buildRewardsGrid({
      nextDayIndex: 2,
      lastClaimDateKey: '2026-08-01',
      lastClaimedDayIndex: 1,
      todayKey: '2026-08-01',
      rewards,
    });
    assert.equal(grid[0].status, 'claimed');
    assert.equal(grid[1].status, 'upcoming');
  });

  test('skip days does not reset — Day 2 remains today', () => {
    const grid = buildRewardsGrid({
      nextDayIndex: 2,
      lastClaimDateKey: '2026-07-28',
      lastClaimedDayIndex: 1,
      todayKey: '2026-08-01',
      rewards,
    });
    assert.equal(grid[0].status, 'claimed');
    assert.equal(grid[1].status, 'today');
    assert.equal(grid[1].coins, 80);
    assert.equal(grid[2].status, 'upcoming');
  });

  test('after Day 7 claim on new day: fresh cycle Day 1 today', () => {
    const grid = buildRewardsGrid({
      nextDayIndex: 1,
      lastClaimDateKey: '2026-07-31',
      lastClaimedDayIndex: 7,
      todayKey: '2026-08-01',
      rewards,
    });
    assert.equal(grid[0].status, 'today');
    assert.ok(grid.slice(1).every((d) => d.status === 'upcoming'));
  });

  test('mid-cycle after claim same day shows claimed through current', () => {
    const grid = buildRewardsGrid({
      nextDayIndex: 4,
      lastClaimDateKey: '2026-08-01',
      lastClaimedDayIndex: 3,
      todayKey: '2026-08-01',
      rewards,
    });
    assert.equal(grid[0].status, 'claimed');
    assert.equal(grid[1].status, 'claimed');
    assert.equal(grid[2].status, 'claimed');
    assert.equal(grid[3].status, 'upcoming');
  });
});

describe('IST day boundary helpers used by check-in', () => {
  test('resetsAt is next IST midnight', () => {
    // 2026-08-01 18:30 IST = 2026-08-01 13:00 UTC
    const now = new Date('2026-08-01T13:00:00.000Z');
    const key = istDateKey(now);
    assert.equal(key, '2026-08-01');
    const { end } = istDayBounds(key);
    // Next IST midnight = 2026-08-01 18:30 UTC
    assert.equal(end.toISOString(), '2026-08-01T18:30:00.000Z');
  });

  test('next reward unlocks exactly at IST midnight (date key rolls)', () => {
    const before = new Date('2026-08-01T18:29:59.999Z');
    const atMidnight = new Date('2026-08-01T18:30:00.000Z');
    assert.equal(istDateKey(before), '2026-08-01');
    assert.equal(istDateKey(atMidnight), '2026-08-02');

    const claimedAug1 = buildRewardsGrid({
      nextDayIndex: 2,
      lastClaimDateKey: '2026-08-01',
      lastClaimedDayIndex: 1,
      todayKey: istDateKey(before),
      rewards: [50, 80, 50, 50, 50, 50, 100],
    });
    assert.ok(claimedAug1.every((d) => d.status !== 'today'));

    const unlocked = buildRewardsGrid({
      nextDayIndex: 2,
      lastClaimDateKey: '2026-08-01',
      lastClaimedDayIndex: 1,
      todayKey: istDateKey(atMidnight),
      rewards: [50, 80, 50, 50, 50, 50, 100],
    });
    assert.equal(unlocked[1].status, 'today');
    assert.equal(unlocked[1].coins, 80);
  });

  test('device timezone cannot invent a second claim day key', () => {
    const instant = new Date('2026-08-01T20:00:00.000Z');
    assert.equal(istDateKey(instant), '2026-08-02');
    assert.equal(
      dailyCheckInTransactionId('u1', istDateKey(instant)),
      'daily_checkin_u1_2026-08-02'
    );
  });
});

describe('isInsideReminderWindow', () => {
  beforeEach(() => {
    process.env.DAILY_CHECKIN_REMINDER_HOUR_IST = '11';
    process.env.DAILY_CHECKIN_REMINDER_WINDOW_MINUTES = '20';
  });

  test('true during 11:00–11:19 IST', () => {
    // 11:05 IST = 05:35 UTC
    const inside = new Date('2026-08-01T05:35:00.000Z');
    assert.equal(isInsideReminderWindow(inside), true);
  });

  test('false outside window', () => {
    // 12:00 IST = 06:30 UTC
    const outside = new Date('2026-08-01T06:30:00.000Z');
    assert.equal(isInsideReminderWindow(outside), false);
  });
});
