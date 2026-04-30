import type { Request } from 'express';

export type ParsedDateRange = {
  from?: Date;
  to?: Date;
  hasRange: boolean;
  /** ISO strings as provided (useful to echo back) */
  fromIso?: string;
  toIso?: string;
};

const MAX_RANGE_DAYS = 366;

function parseIsoDate(input: unknown): { date?: Date; iso?: string } {
  if (typeof input !== 'string' || !input.trim()) return {};
  const iso = input.trim();
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return {};
  return { date: d, iso };
}

export function parseAdminDateRange(req: Request): ParsedDateRange {
  const { date: from, iso: fromIso } = parseIsoDate(req.query.from);
  const { date: to, iso: toIso } = parseIsoDate(req.query.to);

  const hasRange = Boolean(from || to);
  if (!hasRange) return { hasRange: false };

  // Require both for deterministic behavior.
  if (!from || !to) return { hasRange: false };

  if (to.getTime() <= from.getTime()) return { hasRange: false };

  const maxMs = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;
  if (to.getTime() - from.getTime() > maxMs) return { hasRange: false };

  return { from, to, hasRange: true, fromIso, toIso };
}

