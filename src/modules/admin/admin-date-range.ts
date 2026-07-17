import type { Request } from 'express';

export type ParsedDateRange = {
  from?: Date;
  to?: Date;
  hasRange: boolean;
  /** ISO strings as provided (useful to echo back) */
  fromIso?: string;
  toIso?: string;
  invalidReason?: 'missing_from' | 'missing_to' | 'invalid_bounds' | 'range_too_wide';
};

const MAX_RANGE_DAYS = 366;

const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function parseIsoDate(input: unknown): { date?: Date; iso?: string; supplied: boolean } {
  if (typeof input !== 'string' || !input.trim()) return { supplied: false };
  const iso = input.trim();
  if (!ISO_INSTANT_RE.test(iso)) return { iso, supplied: true };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { iso, supplied: true };
  return { date: d, iso, supplied: true };
}

export function parseAdminDateRange(req: Request): ParsedDateRange {
  const fromParsed = parseIsoDate(req.query.from);
  const toParsed = parseIsoDate(req.query.to);
  const { date: from, iso: fromIso } = fromParsed;
  const { date: to, iso: toIso } = toParsed;

  const hasRange = fromParsed.supplied || toParsed.supplied;
  if (!hasRange) return { hasRange: false };

  if ((fromParsed.supplied && !from) || (toParsed.supplied && !to)) {
    return { hasRange: false, fromIso, toIso, invalidReason: 'invalid_bounds' };
  }
  if (!from) return { hasRange: false, fromIso, toIso, invalidReason: 'missing_from' };
  if (!to) return { hasRange: false, fromIso, toIso, invalidReason: 'missing_to' };

  if (to.getTime() <= from.getTime()) {
    return { hasRange: false, fromIso, toIso, invalidReason: 'invalid_bounds' };
  }

  const maxMs = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;
  if (to.getTime() - from.getTime() > maxMs) {
    return { hasRange: false, fromIso, toIso, invalidReason: 'range_too_wide' };
  }

  return { from, to, hasRange: true, fromIso, toIso };
}

