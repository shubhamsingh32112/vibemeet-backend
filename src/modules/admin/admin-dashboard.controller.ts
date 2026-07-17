import type { Request, Response } from 'express';
import { assertAdmin } from '../../middlewares/staff.middleware';
import { logError, logInfo } from '../../utils/logger';
import { parseAdminDateRange } from './admin-date-range';
import {
  dashboardAlerts,
  dashboardCallAnalytics,
  dashboardGeoMock,
  dashboardHeatmapDemo,
  dashboardLiveCalls,
  dashboardOverviewPayload,
  dashboardPayouts,
  dashboardRazorpayBalance,
  dashboardRealtimePayload,
  dashboardRevenueSeries,
  dashboardRechargeTransactionsForDay,
  dashboardTopAgencies,
  dashboardTopBds,
  dashboardTopHosts,
} from './admin-dashboard.service';
import {
  dashboardRazorpayCollectedAmount,
  RazorpayCollectedError,
} from './admin-razorpay-collected.service';

function extractDashboardRange(req: Request) {
  const parsed = parseAdminDateRange(req);
  if (parsed.hasRange && parsed.from && parsed.to) {
    logInfo('admin_dashboard_date_filter_applied', {
      path: req.path,
      from: parsed.fromIso ?? parsed.from.toISOString(),
      to: parsed.toIso ?? parsed.to.toISOString(),
    });
    return {
      from: parsed.from,
      to: parsed.to,
      fromIso: parsed.fromIso,
      toIso: parsed.toIso,
    };
  }
  if (parsed.invalidReason) {
    logInfo('admin_dashboard_date_filter_ignored', {
      path: req.path,
      reason: parsed.invalidReason,
      from: parsed.fromIso ?? null,
      to: parsed.toIso ?? null,
    });
  }
  return undefined;
}

export const getDashboardOverview = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = await dashboardOverviewPayload(extractDashboardRange(req));
    res.json({ success: true, data });
  } catch (error) {
    logError('getDashboardOverview', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getDashboardRevenue = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const days = Math.min(90, Math.max(1, parseInt(String(req.query.days ?? '14'), 10) || 14));
    const data = await dashboardRevenueSeries(days, extractDashboardRange(req));
    res.json({ success: true, data });
  } catch (error) {
    logError('getDashboardRevenue', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getDashboardLiveCalls = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = await dashboardLiveCalls(parseInt(String(req.query.limit ?? '20'), 10));
    res.json({ success: true, data });
  } catch (error) {
    logError('getDashboardLiveCalls', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getDashboardRealtime = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = await dashboardRealtimePayload();
    res.json({ success: true, data });
  } catch (error) {
    logError('getDashboardRealtime', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getDashboardTopHosts = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = await dashboardTopHosts(parseInt(String(req.query.limit ?? '10'), 10), extractDashboardRange(req));
    res.json({ success: true, data });
  } catch (error) {
    logError('getDashboardTopHosts', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getDashboardTopBds = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = await dashboardTopBds(parseInt(String(req.query.limit ?? '10'), 10), extractDashboardRange(req));
    res.json({ success: true, data });
  } catch (error) {
    logError('getDashboardTopBds', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getDashboardTopAgencies = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = await dashboardTopAgencies(parseInt(String(req.query.limit ?? '10'), 10), extractDashboardRange(req));
    res.json({ success: true, data });
  } catch (error) {
    logError('getDashboardTopAgencies', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getDashboardAlerts = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = await dashboardAlerts();
    res.json({ success: true, data });
  } catch (error) {
    logError('getDashboardAlerts', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getDashboardHeatmap = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = dashboardHeatmapDemo();
    res.json({ success: true, data });
  } catch (error) {
    logError('getDashboardHeatmap', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getDashboardCallAnalytics = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = await dashboardCallAnalytics(extractDashboardRange(req));
    res.json({ success: true, data });
  } catch (error) {
    logError('getDashboardCallAnalytics', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getDashboardPayouts = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = await dashboardPayouts(parseInt(String(req.query.limit ?? '25'), 10), extractDashboardRange(req));
    res.json({ success: true, data });
  } catch (error) {
    logError('getDashboardPayouts', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getDashboardGeo = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = dashboardGeoMock();
    res.json({ success: true, data });
  } catch (error) {
    logError('getDashboardGeo', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getDashboardRazorpayBalance = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = await dashboardRazorpayBalance();
    res.json({ success: true, data });
  } catch (error) {
    logError('getDashboardRazorpayBalance', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getDashboardRazorpayCollectedAmount = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const parsed = parseAdminDateRange(req);
    if (parsed.invalidReason) {
      res.status(400).json({
        success: false,
        error: 'A valid from/to half-open date range is required when either bound is supplied.',
        code: parsed.invalidReason,
      });
      return;
    }
    const range =
      parsed.hasRange && parsed.from && parsed.to
        ? { from: parsed.from, to: parsed.to }
        : undefined;
    const data = await dashboardRazorpayCollectedAmount(range);
    res.json({ success: true, data });
  } catch (error) {
    if (error instanceof RazorpayCollectedError) {
      res.status(error.status).json({ success: false, error: error.message, code: error.code });
      return;
    }
    logError('getDashboardRazorpayCollectedAmount', error as Error);
    res.status(503).json({
      success: false,
      error: 'Unable to calculate Razorpay Collected Amount.',
      code: 'PROVIDER_UNAVAILABLE',
    });
  }
};

export const getDashboardRechargeTransactions = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const date = typeof req.query.date === 'string' ? req.query.date.trim() : '';
    if (!date) {
      res.status(400).json({ success: false, error: 'date query param required (YYYY-MM-DD IST)' });
      return;
    }
    const data = await dashboardRechargeTransactionsForDay(date);
    res.json({ success: true, data });
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_IST_DATE') {
      res.status(400).json({ success: false, error: 'Invalid date; use YYYY-MM-DD (IST calendar day)' });
      return;
    }
    logError('getDashboardRechargeTransactions', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
