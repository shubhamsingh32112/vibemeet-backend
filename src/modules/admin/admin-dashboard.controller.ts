import type { Request, Response } from 'express';
import { assertAdmin } from '../../middlewares/staff.middleware';
import { logError } from '../../utils/logger';
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
  dashboardTopAgencies,
  dashboardTopBds,
  dashboardTopHosts,
} from './admin-dashboard.service';

export const getDashboardOverview = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = await dashboardOverviewPayload();
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
    const data = await dashboardRevenueSeries(days);
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
    const data = await dashboardTopHosts(parseInt(String(req.query.limit ?? '10'), 10));
    res.json({ success: true, data });
  } catch (error) {
    logError('getDashboardTopHosts', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getDashboardTopBds = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = await dashboardTopBds(parseInt(String(req.query.limit ?? '10'), 10));
    res.json({ success: true, data });
  } catch (error) {
    logError('getDashboardTopBds', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getDashboardTopAgencies = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = await dashboardTopAgencies(parseInt(String(req.query.limit ?? '10'), 10));
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
    const data = await dashboardCallAnalytics();
    res.json({ success: true, data });
  } catch (error) {
    logError('getDashboardCallAnalytics', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getDashboardPayouts = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = await dashboardPayouts(parseInt(String(req.query.limit ?? '25'), 10));
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
