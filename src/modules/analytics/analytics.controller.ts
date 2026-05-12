import type { Request, Response } from 'express';
import { assertAdmin } from '../../middlewares/staff.middleware';
import {
  rebuildAnalyticsDateRange,
  rebuildAnalyticsUtcDay,
  utcDateKey,
} from './analytics-aggregation.service';

/**
 * POST /admin/analytics/rebuild — rebuild daily rollup rows for [fromKey .. toKey] inclusive (UTC date keys YYYY-MM-DD).
 */
export const postAdminAnalyticsRebuild = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const fromRaw = String(req.body?.from ?? req.query.from ?? '').trim();
    const toRaw = String(req.body?.to ?? req.query.to ?? '').trim();
    const day = String(req.body?.day ?? req.query.day ?? '').trim();

    if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
      await rebuildAnalyticsUtcDay(day);
      res.json({ success: true, data: { daysProcessed: 1, day } });
      return;
    }

    const toKey = toRaw || utcDateKey(new Date());
    const fromKey = fromRaw || toKey;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromKey) || !/^\d{4}-\d{2}-\d{2}$/.test(toKey)) {
      res.status(400).json({
        success: false,
        error: 'Provide from/to as YYYY-MM-DD UTC or body.day for single day',
      });
      return;
    }

    const daysProcessed = await rebuildAnalyticsDateRange(fromKey, toKey);
    res.json({ success: true, data: { daysProcessed, fromKey, toKey } });
  } catch (error) {
    console.error('postAdminAnalyticsRebuild error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
