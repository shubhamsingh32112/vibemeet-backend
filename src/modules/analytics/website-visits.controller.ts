import type { Request, Response } from 'express';
import { assertAdmin } from '../../middlewares/staff.middleware';
import { logError } from '../../utils/logger';
import { istDateKey, IST_TIMEZONE } from '../../utils/ist-time';
import { parseAdminDateRange } from '../admin/admin-date-range';
import { WebsiteHomepageVisitDay } from './website-homepage-visit-day.model';

export const WEBSITE_VISIT_TRACKING_START =
  process.env.WEBSITE_VISIT_TRACKING_START || '2026-07-18T00:00:00.000Z';

const VISITOR_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function rejectInvalidRange(
  range: ReturnType<typeof parseAdminDateRange>,
  res: Response,
): boolean {
  if (!range.invalidReason) return false;
  res.status(400).json({
    success: false,
    error: `Invalid date range: ${range.invalidReason}`,
  });
  return true;
}

/** Public: record a unique homepage visit for today (IST). Idempotent per visitor/day. */
export const recordWebsiteHomepageVisit = async (req: Request, res: Response): Promise<void> => {
  try {
    const visitorId = firstString(req.body?.visitorId)?.trim();
    if (!visitorId || !VISITOR_ID_RE.test(visitorId)) {
      res.status(400).json({ success: false, error: 'Invalid visitorId' });
      return;
    }

    const now = new Date();
    const day = istDateKey(now);
    await WebsiteHomepageVisitDay.updateOne(
      { visitorId, day },
      { $setOnInsert: { visitorId, day, firstHitAt: now } },
      { upsert: true },
    );

    res.status(204).send();
  } catch (error) {
    logError('recordWebsiteHomepageVisit', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/** Admin: unique homepage visits in range — one count per anonymous browser per IST day. */
export const getWebsiteVisits = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const range = parseAdminDateRange(req);
    if (rejectInvalidRange(range, res)) return;

    const match: Record<string, unknown> = {};
    if (range.hasRange && range.from && range.to) {
      const fromDay = istDateKey(range.from);
      const toDayExclusive = istDateKey(range.to);
      match.day = { $gte: fromDay, $lt: toDayExclusive };
    } else {
      const trackingDay = istDateKey(new Date(WEBSITE_VISIT_TRACKING_START));
      match.day = { $gte: trackingDay };
    }

    // Each Mongo row is already unique on (visitorId, day). Counting rows = once per
    // browser per day (Mon+Tue visits from the same browser in last 7d → 2).
    const uniqueVisitors = await WebsiteHomepageVisitDay.countDocuments(match);

    res.json({
      success: true,
      data: {
        uniqueVisitors,
        meta: {
          trackingStart: WEBSITE_VISIT_TRACKING_START,
          coverage: 'forward_only',
          uniqueness: 'visitor_per_ist_day',
          timezone: IST_TIMEZONE,
          range: range.hasRange ? { from: range.from, to: range.to } : null,
        },
      },
    });
  } catch (error) {
    logError('getWebsiteVisits', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
