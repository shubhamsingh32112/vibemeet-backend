import type { Request, Response } from 'express';
import { assertAdmin } from '../../middlewares/staff.middleware';
import { logError } from '../../utils/logger';
import { parseAdminDateRange } from './admin-date-range';
import {
  type AnalyticsPeriod,
  cachedLeaderboardHosts,
  financePayoutsSummaryPayload,
  financeSettlementsPayload,
  momentsPaidUsersPayload,
  momentsPremiumUsersPayload,
  revenueSummaryPayload,
  usersSummaryPayload,
  usersLoginSeriesPayload,
  usersSignupSeriesPayload,
  coinRechargePaidUsersPayload,
  vipPaidUsersPayload,
  walletTransactionsPayload,
} from './admin-analytics.service';
import {
  leaderboardHosts,
  parseHostSort,
  parseLeaderboardPeriod,
} from './admin-leaderboards.service';
import { clampDashboardLimit } from './admin-dashboard.service';

function parsePeriod(raw: unknown): AnalyticsPeriod {
  const p = String(raw ?? '30d');
  if (p === 'today' || p === '7d' || p === '30d') return p;
  return '30d';
}

function parsePageLimit(req: Request): { page: number; limit: number } {
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
  return { page, limit };
}

export const getUsersSummary = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = await usersSummaryPayload();
    res.json({ success: true, data });
  } catch (error) {
    logError('getUsersSummary', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getUsersLoginSeries = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = await usersLoginSeriesPayload(req.query.granularity);
    res.json({ success: true, data });
  } catch (error) {
    logError('getUsersLoginSeries', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getUsersSignupSeries = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const data = await usersSignupSeriesPayload(req.query.granularity, from, to);
    res.json({ success: true, data });
  } catch (error) {
    logError('getUsersSignupSeries', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getCoinsPaidUsers = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const { page, limit } = parsePageLimit(req);
    const data = await coinRechargePaidUsersPayload(page, limit);
    res.json({ success: true, data });
  } catch (error) {
    logError('getCoinsPaidUsers', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getMomentsPaidUsers = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const { page, limit } = parsePageLimit(req);
    const data = await momentsPaidUsersPayload(page, limit);
    res.json({ success: true, data });
  } catch (error) {
    logError('getMomentsPaidUsers', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getMomentsPremiumUsers = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const { page, limit } = parsePageLimit(req);
    const data = await momentsPremiumUsersPayload(page, limit);
    res.json({ success: true, data });
  } catch (error) {
    logError('getMomentsPremiumUsers', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getVipPaidUsers = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const { page, limit } = parsePageLimit(req);
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : 'all';
    const statusFilter =
      rawStatus === 'active' || rawStatus === 'expired' ? rawStatus : 'all';
    const data = await vipPaidUsersPayload(page, limit, statusFilter);
    res.json({ success: true, data });
  } catch (error) {
    logError('getVipPaidUsers', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getWalletTransactions = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const { page, limit } = parsePageLimit(req);
    const source = typeof req.query.source === 'string' ? req.query.source : undefined;
    const range = parseAdminDateRange(req);
    const data = await walletTransactionsPayload(
      page,
      limit,
      source,
      range.hasRange ? range.from : undefined,
      range.hasRange ? range.to : undefined
    );
    res.json({ success: true, data });
  } catch (error) {
    logError('getWalletTransactions', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getFinancePayments = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const { page, limit } = parsePageLimit(req);
    const source = String(req.query.source ?? 'video_call');
    const range = parseAdminDateRange(req);
    const data = await walletTransactionsPayload(
      page,
      limit,
      source,
      range.hasRange ? range.from : undefined,
      range.hasRange ? range.to : undefined
    );
    res.json({ success: true, data });
  } catch (error) {
    logError('getFinancePayments', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getFinancePayoutsSummary = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = await financePayoutsSummaryPayload(parsePeriod(req.query.period));
    res.json({ success: true, data });
  } catch (error) {
    logError('getFinancePayoutsSummary', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getFinanceSettlements = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const { page, limit } = parsePageLimit(req);
    const data = await financeSettlementsPayload(page, limit);
    res.json({ success: true, data });
  } catch (error) {
    logError('getFinanceSettlements', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getRevenueAnalyticsSummary = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = await revenueSummaryPayload(parsePeriod(req.query.period));
    res.json({ success: true, data });
  } catch (error) {
    logError('getRevenueAnalyticsSummary', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getCachedLeaderboardHosts = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const period = parseLeaderboardPeriod(req.query.period);
    const sort = parseHostSort(req.query.sort);
    const limit = clampDashboardLimit(parseInt(String(req.query.limit ?? '50'), 10), 50);
    const cacheKey = `${period}:${sort}:${limit}`;
    const data = await cachedLeaderboardHosts(cacheKey, () =>
      leaderboardHosts({ period, sort, limit })
    );
    res.json({
      success: true,
      data: { ...data, cacheTtlSeconds: 1800, refreshedAt: new Date().toISOString() },
    });
  } catch (error) {
    logError('getCachedLeaderboardHosts', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
