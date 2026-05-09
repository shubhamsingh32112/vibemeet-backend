/**
 * Creator Task Definitions
 *
 * ⚠️ These values must match UI exactly (no magic numbers in frontend).
 *
 * Tasks are based on total completed video call minutes **within the
 * current daily period**.  The period resets every day at 23:59 (server
 * local time — IST in production).
 *
 * Only ended calls with duration > 0 that occurred in the current period
 * count towards task progress.
 */

export interface CreatorTaskDefinition {
  key: string;
  thresholdMinutes: number;
  rewardCoins: number;
}

export const CREATOR_TASKS: CreatorTaskDefinition[] = [
  { key: 'minutes_200', thresholdMinutes: 200, rewardCoins: 100 },
  { key: 'minutes_350', thresholdMinutes: 350, rewardCoins: 150 },
  { key: 'minutes_480', thresholdMinutes: 480, rewardCoins: 300 },
  { key: 'minutes_600', thresholdMinutes: 600, rewardCoins: 300 },
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

// ══════════════════════════════════════════════════════════════════════════
// DAILY PERIOD HELPERS
// ══════════════════════════════════════════════════════════════════════════

/**
 * The daily task period resets at 23:59 server-local time.
 *
 * Period boundaries:
 *   periodStart = yesterday 23:59  (if now < today 23:59)
 *                 today 23:59      (if now >= today 23:59)
 *   periodEnd   = periodStart + 24 h
 *   resetsAt    = periodEnd        (next reset)
 */
export function getDailyPeriodBoundsForInstant(when: Date): {
  periodStart: Date;
  periodEnd: Date;
  resetsAt: Date;
} {
  const todayReset = new Date(
    when.getFullYear(),
    when.getMonth(),
    when.getDate(),
    23, 59, 0, 0,
  );

  let periodStart: Date;

  if (when.getTime() >= todayReset.getTime()) {
    periodStart = todayReset;
  } else {
    periodStart = new Date(todayReset.getTime() - 24 * 60 * 60 * 1000);
  }

  const periodEnd = new Date(periodStart.getTime() + 24 * 60 * 60 * 1000);

  return { periodStart, periodEnd, resetsAt: periodEnd };
}

export function getDailyPeriodBounds(): {
  periodStart: Date;
  periodEnd: Date;
  resetsAt: Date;
} {
  return getDailyPeriodBoundsForInstant(new Date());
}
