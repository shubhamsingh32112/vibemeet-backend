import type { Request, Response } from 'express';
import { assertAdmin } from '../../middlewares/staff.middleware';
import { logError } from '../../utils/logger';
import { clampDashboardLimit } from './admin-dashboard.service';
import {
  leaderboardHosts,
  leaderboardUsers,
  parseHostSort,
  parseLeaderboardPeriod,
  parseUserSort,
} from './admin-leaderboards.service';

export const getLeaderboardHosts = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = await leaderboardHosts({
      period: parseLeaderboardPeriod(req.query.period),
      sort: parseHostSort(req.query.sort),
      limit: clampDashboardLimit(parseInt(String(req.query.limit ?? '50'), 10), 50),
    });
    res.json({ success: true, data });
  } catch (error) {
    logError('getLeaderboardHosts', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getLeaderboardUsers = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = await leaderboardUsers({
      period: parseLeaderboardPeriod(req.query.period),
      sort: parseUserSort(req.query.sort),
      limit: clampDashboardLimit(parseInt(String(req.query.limit ?? '50'), 10), 50),
    });
    res.json({ success: true, data });
  } catch (error) {
    logError('getLeaderboardUsers', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
