/** Asia/Kolkata (IST, UTC+5:30) — no DST. Used for admin recharge reporting. */
export const IST_TIMEZONE = 'Asia/Kolkata';

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

const istDateKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: IST_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const istDateTimeFormatter = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST_TIMEZONE,
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** Calendar date `YYYY-MM-DD` in IST for the given instant. */
export function istDateKey(date: Date): string {
  return istDateKeyFormatter.format(date);
}

/** Half-open Mongo match for header IST range `[from, to)`. */
export function istRangeMatch(from: Date, to: Date): { $gte: Date; $lt: Date } {
  return { $gte: from, $lt: to };
}

/** Alias for rolling IST calendar-day windows ending at `now`. */
export function istRollingCalendarDays(days: number, now = new Date()): { from: Date; to: Date } {
  return istLookbackCalendarDays(days, now);
}

/** Half-open `[start, end)` bounds for one IST calendar day. */
export function istDayBounds(dateKey: string): { start: Date; end: Date } {
  const [y, m, d] = dateKey.split('-').map(Number);
  if (!y || !m || !d) {
    throw new Error(`Invalid IST date key: ${dateKey}`);
  }
  const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - IST_OFFSET_MS);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/** Start of the current IST calendar day. */
export function istStartOfToday(now = new Date()): Date {
  return istDayBounds(istDateKey(now)).start;
}

/** IST calendar date key for yesterday relative to `now`. */
export function istYesterdayKey(now = new Date()): string {
  return addIstDays(istDateKey(now), -1);
}

/** Add calendar days to an IST date key (handles month/year rollover). */
export function addIstDays(dateKey: string, days: number): string {
  const { start } = istDayBounds(dateKey);
  return istDateKey(new Date(start.getTime() + days * 24 * 60 * 60 * 1000));
}

/** Inclusive list of IST date keys from `fromKey` through `toKey`. */
export function iterIstDateKeys(fromKey: string, toKey: string): string[] {
  const keys: string[] = [];
  let cur = fromKey;
  while (cur <= toKey) {
    keys.push(cur);
    cur = addIstDays(cur, 1);
  }
  return keys;
}

/** Last `n` IST calendar days ending today (inclusive), oldest first. */
export function istDateKeysLastNDays(n: number, now = new Date()): string[] {
  const capped = Math.min(90, Math.max(1, n));
  const todayKey = istDateKey(now);
  const fromKey = addIstDays(todayKey, -(capped - 1));
  return iterIstDateKeys(fromKey, todayKey);
}

/** Human-readable IST date/time for admin UI. */
export function formatIstDateTime(date: Date): string {
  return `${istDateTimeFormatter.format(date)} IST`;
}

/** Hour bucket key matching Mongo `$dateToString` with `%Y-%m-%d %H:00` in Asia/Kolkata. */
export function istHourKey(date: Date): string {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIMEZONE,
    hour: '2-digit',
    hour12: false,
  }).format(date);
  return `${istDateKey(date)} ${hour.padStart(2, '0')}:00`;
}

/** Start of the IST hour containing `date`. */
export function istStartOfHour(date: Date): Date {
  const key = istHourKey(date);
  const [datePart, hourPart] = key.split(' ');
  const [y, m, d] = datePart.split('-').map(Number);
  const hour = parseInt(hourPart, 10);
  return new Date(Date.UTC(y, m - 1, d, hour, 0, 0, 0) - IST_OFFSET_MS);
}

/** `{ from, to }` covering the last `days` IST calendar days through `now` (inclusive). */
export function istLookbackCalendarDays(days: number, now = new Date()): { from: Date; to: Date } {
  const capped = Math.max(1, days);
  const keys = istDateKeysLastNDays(capped, now);
  return {
    from: istDayBounds(keys[0]).start,
    to: now,
  };
}

export function iterIstHourBuckets(
  from: Date,
  to: Date
): Array<{ key: string; label: string; startDate: string }> {
  const buckets: Array<{ key: string; label: string; startDate: string }> = [];
  let cur = istStartOfHour(from);
  const end = new Date(to);
  while (cur <= end) {
    const key = istHourKey(cur);
    const hourLabel = key.slice(-5);
    buckets.push({
      key,
      label: hourLabel,
      startDate: cur.toISOString(),
    });
    cur = new Date(cur.getTime() + 60 * 60 * 1000);
  }
  return buckets;
}

export function iterIstDateBucketDefs(
  fromKey: string,
  toKey: string
): Array<{ key: string; label: string; startDate: string }> {
  return iterIstDateKeys(fromKey, toKey).map((date) => ({
    key: date,
    label: date,
    startDate: date,
  }));
}

export const IST_DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIstDateKey(value: string): boolean {
  if (!IST_DATE_KEY_RE.test(value)) return false;
  try {
    istDayBounds(value);
    return true;
  } catch {
    return false;
  }
}
