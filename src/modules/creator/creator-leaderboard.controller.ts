import type { Request, Response } from 'express';
import { User } from '../user/user.model';
import { logError } from '../../utils/logger';
import { clampDashboardLimit } from '../admin/admin-dashboard.service';
import {
  parseHostSort,
  parseLeaderboardPeriod,
} from '../admin/admin-leaderboards.service';
import {
  getCreatorLeaderboardList,
  getCreatorLeaderboardSummary,
} from './creator-leaderboard.service';

async function resolveCreatorUser(req: Request, res: Response) {
  if (!req.auth) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return null;
  }

  const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
  if (!currentUser) {
    res.status(404).json({ success: false, error: 'User not found' });
    return null;
  }

  if (currentUser.role !== 'creator' && currentUser.role !== 'admin') {
    res.status(403).json({ success: false, error: 'Only creators can access leaderboard' });
    return null;
  }

  return currentUser;
}

export const getCreatorLeaderboardSummaryHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const currentUser = await resolveCreatorUser(req, res);
    if (!currentUser) return;

    const data = await getCreatorLeaderboardSummary(currentUser._id.toString());
    res.json({ success: true, data });
  } catch (error) {
    logError('getCreatorLeaderboardSummary', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getCreatorLeaderboardHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const currentUser = await resolveCreatorUser(req, res);
    if (!currentUser) return;

    const data = await getCreatorLeaderboardList({
      period: parseLeaderboardPeriod(req.query.period),
      sort: parseHostSort(req.query.sort),
      limit: clampDashboardLimit(parseInt(String(req.query.limit ?? '50'), 10), 50),
    });
    res.json({ success: true, data });
  } catch (error) {
    logError('getCreatorLeaderboard', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
