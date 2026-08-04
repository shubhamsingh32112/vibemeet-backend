/**
 * Daily check-in configuration.
 * Rewards are server-authoritative — never trust client amounts.
 */

const DEFAULT_REWARDS = [50, 80, 50, 50, 50, 50, 100] as const;

function parseRewards(raw: string | undefined): number[] {
  if (!raw || !raw.trim()) return [...DEFAULT_REWARDS];
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 7 || parts.some((n) => !Number.isFinite(n) || n <= 0 || !Number.isInteger(n))) {
    return [...DEFAULT_REWARDS];
  }
  return parts;
}

let cachedRewards: number[] | null = null;

/** Reset cache for tests. */
export function __resetCheckInConfigForTests(): void {
  cachedRewards = null;
}

export function isDailyCheckInEnabled(): boolean {
  return process.env.DAILY_CHECKIN_ENABLED === 'true';
}

/** Coin amounts for Day 1..7 (1-indexed externally). */
export function getDailyCheckInRewards(): number[] {
  if (!cachedRewards) {
    cachedRewards = parseRewards(process.env.DAILY_CHECKIN_REWARDS);
  }
  return cachedRewards;
}

export function getDailyCheckInRewardForDay(dayIndex: number): number {
  const rewards = getDailyCheckInRewards();
  if (dayIndex < 1 || dayIndex > 7) {
    throw new Error(`Invalid check-in day index: ${dayIndex}`);
  }
  return rewards[dayIndex - 1];
}

/** IST hour (0–23) when daily reminders should fire. Default 11. */
export function getDailyCheckInReminderHourIst(): number {
  const raw = Number(process.env.DAILY_CHECKIN_REMINDER_HOUR_IST ?? '11');
  if (!Number.isInteger(raw) || raw < 0 || raw > 23) return 11;
  return raw;
}

/** Reminder send window length in minutes after the hour. Default 20. */
export function getDailyCheckInReminderWindowMinutes(): number {
  const raw = Number(process.env.DAILY_CHECKIN_REMINDER_WINDOW_MINUTES ?? '20');
  if (!Number.isInteger(raw) || raw < 5 || raw > 60) return 20;
  return raw;
}

export const CHECKIN_CYCLE_DAYS = 7;
export const CHECKIN_DEEP_LINK = 'zztherapy://home?checkin=1';
