import {
  addIstDays,
  istDateKey,
  istDayBounds,
  IST_TIMEZONE,
} from '../../utils/ist-time';

/**
 * Creator Task Definitions
 *
 * ⚠️ These values must match UI exactly (no magic numbers in frontend).
 *
 * Tasks are based on **paid-call coins earned** within the current
 * weekly period (Monday 00:00 → next Monday 00:00, Asia/Kolkata).
 *
 * Only settled creator CallHistory rows with duration > 0 in the current
 * period count. Progress uses paidCoinsEarned (legacy rows fall back to
 * coinsEarned as all-paid).
 */

export interface CreatorTaskDefinition {
  key: string;
  thresholdPaidCoins: number;
  /** Claim reward — placeholders until product finalizes amounts. */
  rewardCoins: number;
}

export const CREATOR_TASKS: CreatorTaskDefinition[] = [
  // Keys kept for claim identity across periods; thresholds scaled ×30 with 1800 CPM.
  { key: 'paid_coins_15000', thresholdPaidCoins: 450000, rewardCoins: 100 },
  { key: 'paid_coins_20000', thresholdPaidCoins: 600000, rewardCoins: 150 },
  { key: 'paid_coins_30000', thresholdPaidCoins: 900000, rewardCoins: 300 },
];

/**
 * Get task definition by key
 */
export const getTaskByKey = (key: string): CreatorTaskDefinition | undefined => {
  return CREATOR_TASKS.find((task) => task.key === key);
};

/**
 * Validate task key exists
 */
export const isValidTaskKey = (key: string): boolean => {
  return CREATOR_TASKS.some((task) => task.key === key);
};

const IST_WEEKDAY_SHORT = new Intl.DateTimeFormat('en-US', {
  timeZone: IST_TIMEZONE,
  weekday: 'short',
});

function istDaysSinceMonday(when: Date): number {
  const dayName = IST_WEEKDAY_SHORT.format(when);
  const day =
    dayName === 'Sun'
      ? 0
      : dayName === 'Mon'
        ? 1
        : dayName === 'Tue'
          ? 2
          : dayName === 'Wed'
            ? 3
            : dayName === 'Thu'
              ? 4
              : dayName === 'Fri'
                ? 5
                : 6;
  return day === 0 ? 6 : day - 1;
}

// ══════════════════════════════════════════════════════════════════════════
// WEEKLY PERIOD HELPERS (creator targets)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Weekly task period: Monday 00:00 → next Monday 00:00 Asia/Kolkata.
 */
export function getWeeklyPeriodBoundsForInstant(when: Date): {
  periodStart: Date;
  periodEnd: Date;
  resetsAt: Date;
} {
  const mondayKey = addIstDays(istDateKey(when), -istDaysSinceMonday(when));
  const { start: periodStart } = istDayBounds(mondayKey);
  const periodEnd = new Date(periodStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { periodStart, periodEnd, resetsAt: periodEnd };
}

export function getWeeklyPeriodBounds(): {
  periodStart: Date;
  periodEnd: Date;
  resetsAt: Date;
} {
  return getWeeklyPeriodBoundsForInstant(new Date());
}

// ══════════════════════════════════════════════════════════════════════════
// DAILY PERIOD HELPERS (online minutes, chat quota, todayEarnings)
// ══════════════════════════════════════════════════════════════════════════

/**
 * The daily period resets at midnight 00:00 Asia/Kolkata.
 *
 * Period boundaries:
 *   periodStart = today 00:00:00.000 IST
 *   periodEnd   = tomorrow 00:00:00.000 IST
 *   resetsAt    = periodEnd
 */
export function getDailyPeriodBoundsForInstant(when: Date): {
  periodStart: Date;
  periodEnd: Date;
  resetsAt: Date;
} {
  const { start: periodStart, end: periodEnd } = istDayBounds(istDateKey(when));
  return { periodStart, periodEnd, resetsAt: periodEnd };
}

export function getDailyPeriodBounds(): {
  periodStart: Date;
  periodEnd: Date;
  resetsAt: Date;
} {
  return getDailyPeriodBoundsForInstant(new Date());
}

/**
 * Pre-midnight-migration CreatorDailyOnline rows used a 23:59 day boundary.
 * For calendar day starting at `periodStart` (midnight), that legacy key is
 * `periodStart - 1 minute` (previous calendar day 23:59).
 */
export function legacyDailyPeriodStart(periodStart: Date): Date {
  return new Date(periodStart.getTime() - 60_000);
}

/** Midnight + legacy 23:59 keys that map to the same calendar day. */
export function dailyPeriodStartsForLookup(periodStart: Date): Date[] {
  return [periodStart, legacyDailyPeriodStart(periodStart)];
}
