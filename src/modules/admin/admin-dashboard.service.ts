/**
 * Composable aggregations for GET /admin/dashboard/* (BFF-style).
 * Caps limits; indexed queries only.
 */
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { CallHistory } from '../billing/call-history.model';
import { Withdrawal } from '../creator/withdrawal.model';
import { SupportTicket } from '../support/support.model';
import { FraudSignal } from '../fraud/fraud-signal.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { buildAvatarUrls } from '../images/image-url';
import type { IImageAsset } from '../images/image-asset.schema';
import { countOnlineCreatorsPlatform } from '../availability/presence-dashboard.service';

const TOP_BD_ROLE = { role: 'bd' as const };
const MIDDLE_AGENCY_ROLE = { role: 'agency' as const };
const MAX = 100;

function utcStartOfDay(d = new Date()): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

export function clampDashboardLimit(raw: unknown, def: number): number {
  const n = Math.max(1, parseInt(String(raw ?? def), 10) || def);
  return Math.min(MAX, n);
}

function dashboardCreatorAvatarSmUrl(avatar: IImageAsset | null | undefined): string | null {
  const id = typeof avatar?.imageId === 'string' ? avatar.imageId.trim() : '';
  if (!id) return null;
  try {
    return buildAvatarUrls(id).sm;
  } catch {
    return null;
  }
}

export async function dashboardOverviewPayload() {
  const today = utcStartOfDay();
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);

  const [
    onlineCreators,
    agencyCount,
    bdCount,
    pendingWithdrawals,
    callTodayAgg,
    coinFlowToday,
    recentCalls5m,
    activeZeroDuration,
  ] = await Promise.all([
    countOnlineCreatorsPlatform(),
    User.countDocuments({ role: 'agency' }),
    User.countDocuments(TOP_BD_ROLE),
    Withdrawal.countDocuments({ status: 'pending' }),
    CallHistory.aggregate([
      { $match: { createdAt: { $gte: today }, ownerRole: 'user' } },
      {
        $group: {
          _id: null,
          totalCalls: { $sum: 1 },
          totalDurationSec: { $sum: '$durationSeconds' },
          totalCoinsSpent: { $sum: '$coinsDeducted' },
        },
      },
    ]),
    CoinTransaction.aggregate([
      { $match: { createdAt: { $gte: today }, status: 'completed' } },
      { $group: { _id: '$type', total: { $sum: '$coins' }, count: { $sum: 1 } } },
    ]),
    CallHistory.countDocuments({ createdAt: { $gte: fiveMinAgo }, ownerRole: 'user' }),
    CallHistory.countDocuments({
      createdAt: { $gte: fiveMinAgo },
      ownerRole: 'user',
      durationSeconds: 0,
    }),
  ]);

  const callT = callTodayAgg[0] || { totalCalls: 0, totalDurationSec: 0, totalCoinsSpent: 0 };
  const credits = coinFlowToday.find((r: { _id: string }) => r._id === 'credit');
  const debits = coinFlowToday.find((r: { _id: string }) => r._id === 'debit');
  const revenueCoinsToday = (credits?.total ?? 0) - (debits?.total ?? 0);

  return {
    revenueCoinsToday,
    revenueCoinsTodayNote: 'Net completed wallet coin flow today (credits minus debits).',
    liveCallsProxy: recentCalls5m,
    activeUnsettledUserCalls: activeZeroDuration,
    onlineHosts: onlineCreators,
    totalAgencies: agencyCount,
    totalBds: bdCount,
    pendingPayouts: pendingWithdrawals,
    totalCallMinutesToday: Math.round((callT.totalDurationSec / 60) * 100) / 100,
    totalCallsToday: callT.totalCalls,
    coinsSpentOnCallsToday: callT.totalCoinsSpent,
    growthPlaceholder: { revenuePct: null, callsPct: null, hostsPct: null },
    generatedAt: new Date().toISOString(),
  };
}

export async function dashboardRevenueSeries(days: number) {
  const d = Math.min(90, Math.max(1, days));
  const from = new Date();
  from.setUTCHours(0, 0, 0, 0);
  from.setUTCDate(from.getUTCDate() - (d - 1));

  const agg = await CallHistory.aggregate<{ _id: string; revenue: number; commission: number }>([
    { $match: { createdAt: { $gte: from }, ownerRole: 'user' } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
        revenue: { $sum: '$coinsDeducted' },
        commission: { $sum: 0 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  return {
    points: agg.map((r) => ({
      date: r._id,
      revenueCoins: r.revenue,
      commissionCoins: r.commission,
    })),
    note: 'Revenue series uses user-side call history coins deducted per UTC day.',
  };
}

export async function dashboardLiveCalls(limit: number) {
  const lim = clampDashboardLimit(limit, 20);
  const since = new Date(Date.now() - 30 * 60 * 1000);
  const rows = await CallHistory.find({
    ownerRole: 'creator',
    createdAt: { $gte: since },
  })
    .sort({ createdAt: -1 })
    .limit(lim)
    .select('callId otherName otherAvatar durationSeconds coinsEarned createdAt otherCreatorId')
    .lean();

  return {
    calls: rows.map((r) => ({
      callId: r.callId,
      hostName: r.otherName,
      hostId: r.otherCreatorId?.toString() ?? null,
      durationSeconds: r.durationSeconds,
      revenueCoins: r.coinsEarned ?? 0,
      startedAt: r.createdAt,
    })),
    note: 'Recent creator-side call rows (last 30m). Not a substitute for Stream session truth.',
  };
}

export async function dashboardRealtimePayload() {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const [onlineCreators, pendingWithdrawals, openSupportTickets, recentCalls5m, activeBillingSessions] =
    await Promise.all([
      countOnlineCreatorsPlatform(),
      Withdrawal.countDocuments({ status: 'pending' }),
      SupportTicket.countDocuments({ status: { $in: ['open', 'in_progress'] } }),
      CallHistory.countDocuments({ createdAt: { $gte: fiveMinAgo }, ownerRole: 'user' }),
      CallHistory.countDocuments({
        createdAt: { $gte: fiveMinAgo },
        ownerRole: 'user',
        durationSeconds: 0,
      }),
    ]);

  return {
    activeCalls: recentCalls5m,
    activeBillingSessions,
    onlineCreators,
    pendingWithdrawals,
    openSupportTickets,
    timestamp: new Date().toISOString(),
  };
}

export async function dashboardTopHosts(limit: number) {
  const lim = clampDashboardLimit(limit, 10);
  const rows = await Creator.find({})
    .sort({ earningsCoins: -1 })
    .limit(lim)
    .select('name earningsCoins userId avatar')
    .lean();
  const totalCalls = await CallHistory.aggregate([
    { $match: { ownerRole: 'creator' } },
    {
      $group: {
        _id: '$ownerUserId',
        calls: { $sum: 1 },
        minutes: { $sum: { $divide: ['$durationSeconds', 60] } },
      },
    },
  ]);
  const map = new Map(totalCalls.map((t) => [t._id.toString(), t]));

  return {
    rows: rows.map((c, i) => {
      const stat = c.userId ? map.get(c.userId.toString()) : undefined;
      return {
        rank: i + 1,
        host: c.name,
        creatorId: c._id.toString(),
        avatarUrl: dashboardCreatorAvatarSmUrl(c.avatar as IImageAsset | null | undefined),
        minutes: Math.round((stat?.minutes ?? 0) * 100) / 100,
        calls: stat?.calls ?? 0,
        earningsCoins: c.earningsCoins ?? 0,
      };
    }),
  };
}

export async function dashboardTopBds(limit: number) {
  const lim = clampDashboardLimit(limit, 10);
  const bds = await User.find(TOP_BD_ROLE)
    .sort({ staffCoinsBalance: -1 })
    .limit(lim)
    .select('displayName email staffCoinsBalance')
    .lean();
  const bdIds = bds.map((b) => b._id);
  const agencyIds =
    bdIds.length === 0
      ? []
      : await User.find({ bdId: { $in: bdIds }, ...MIDDLE_AGENCY_ROLE }).distinct('_id');
  const hosts = await Creator.aggregate<{ _id: import('mongoose').Types.ObjectId; c: number }>([
    { $match: { assignedAgencyId: { $in: agencyIds } } },
    { $group: { _id: '$assignedAgencyId', c: { $sum: 1 } } },
  ]);
  const hostsByAgency = new Map(hosts.map((h) => [h._id.toString(), h.c]));
  const agenciesByBd = await User.find({ bdId: { $in: bdIds }, ...MIDDLE_AGENCY_ROLE })
    .select('_id bdId')
    .lean();

  return {
    rows: bds.map((b, i) => {
      const childAgencies = agenciesByBd.filter((a) => a.bdId?.toString() === b._id.toString());
      const hostTotal = childAgencies.reduce(
        (sum, a) => sum + (hostsByAgency.get(a._id.toString()) ?? 0),
        0
      );
      return {
        rank: i + 1,
        bdName: b.displayName || b.email || b._id.toString(),
        agencies: childAgencies.length,
        hosts: hostTotal,
        revenueCoins: b.staffCoinsBalance ?? 0,
        commissionCoins: 0,
      };
    }),
  };
}

export async function dashboardTopAgencies(limit: number) {
  const lim = clampDashboardLimit(limit, 10);
  const agencies = await User.find(MIDDLE_AGENCY_ROLE)
    .sort({ staffCoinsBalance: -1 })
    .limit(lim)
    .select('_id email displayName staffCoinsBalance bdId')
    .lean();
  const ids = agencies.map((a) => a._id);
  const hostCounts =
    ids.length === 0
      ? []
      : await Creator.aggregate<{ _id: import('mongoose').Types.ObjectId; c: number }>([
          { $match: { assignedAgencyId: { $in: ids } } },
          { $group: { _id: '$assignedAgencyId', c: { $sum: 1 } } },
        ]);
  const hostsPerAgency = new Map(hostCounts.map((h) => [h._id.toString(), h.c]));

  return {
    rows: agencies.map((a, i) => ({
      rank: i + 1,
      agencyName: a.displayName || a.email || a._id.toString(),
      hosts: hostsPerAgency.get(a._id.toString()) ?? 0,
      revenueCoins: a.staffCoinsBalance ?? 0,
      parentBdId: a.bdId?.toString() ?? null,
    })),
  };
}

export async function dashboardAlerts() {
  const [pendingWd, highOpenFraud, urgentSupport] = await Promise.all([
    Withdrawal.countDocuments({ status: 'pending' }),
    FraudSignal.countDocuments({ status: 'open', severity: { $in: ['high', 'critical'] } }),
    SupportTicket.countDocuments({
      priority: { $in: ['high', 'urgent'] },
      status: { $in: ['open', 'in_progress'] },
    }),
  ]);

  const alerts: Array<{
    id: string;
    type: string;
    severity: 'info' | 'warning' | 'danger';
    message: string;
    createdAt: string;
  }> = [];

  if (pendingWd > 0) {
    alerts.push({
      id: 'wd-pending',
      type: 'payout',
      severity: pendingWd > 20 ? 'warning' : 'info',
      message: `${pendingWd} pending payout request(s)`,
      createdAt: new Date().toISOString(),
    });
  }
  if (highOpenFraud > 0) {
    alerts.push({
      id: 'fraud-open',
      type: 'fraud',
      severity: 'danger',
      message: `${highOpenFraud} high/critical fraud signal(s) open`,
      createdAt: new Date().toISOString(),
    });
  }
  if (urgentSupport > 0) {
    alerts.push({
      id: 'support-urgent',
      type: 'support',
      severity: 'warning',
      message: `${urgentSupport} urgent support ticket(s)`,
      createdAt: new Date().toISOString(),
    });
  }

  return { alerts };
}

export function dashboardHeatmapDemo() {
  const cells: Array<{ day: number; hour: number; intensity: number }> = [];
  for (let day = 0; day < 7; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      cells.push({ day, hour, intensity: Math.floor(Math.random() * 5) });
    }
  }
  return { isDemo: true, cells, note: 'Demo heatmap until hourly activity aggregation exists.' };
}

export async function dashboardCallAnalytics() {
  const today = utcStartOfDay();
  const thirty = new Date(today);
  thirty.setUTCDate(thirty.getUTCDate() - 30);

  const [todayAgg, monthAgg] = await Promise.all([
    CallHistory.aggregate([
      { $match: { createdAt: { $gte: today }, ownerRole: 'user' } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          answered: { $sum: { $cond: [{ $gt: ['$durationSeconds', 0] }, 1, 0] } },
          missed: { $sum: { $cond: [{ $eq: ['$durationSeconds', 0] }, 1, 0] } },
          avgDur: { $avg: '$durationSeconds' },
        },
      },
    ]),
    CallHistory.aggregate([
      { $match: { createdAt: { $gte: thirty }, ownerRole: 'user' } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
          c: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const t = todayAgg[0] || { total: 0, answered: 0, missed: 0, avgDur: 0 };
  return {
    today: {
      totalCalls: t.total,
      answeredCalls: t.answered,
      missedCalls: t.missed,
      avgCallDurationSec: Math.round(t.avgDur || 0),
    },
    dailyVolume: monthAgg.map((r) => ({ date: r._id, calls: r.c })),
  };
}

export async function dashboardPayouts(limit: number) {
  const lim = clampDashboardLimit(limit, 25);
  const rows = await Withdrawal.find({ status: 'pending' })
    .sort({ requestedAt: -1 })
    .limit(lim)
    .populate({ path: 'creatorUserId', select: 'email role' })
    .populate({ path: 'staffUserId', select: 'email role' })
    .lean();

  return {
    rows: rows.map((w) => {
      const cu = w.creatorUserId as { email?: string; role?: string } | undefined;
      const su = w.staffUserId as { email?: string; role?: string } | undefined;
      const label = cu?.email ?? su?.email ?? 'Unknown';
      const role = cu?.role ?? su?.role ?? 'unknown';
      return {
        id: w._id.toString(),
        userLabel: label,
        role,
        amount: w.amount,
        requestedAt: w.requestedAt,
        status: w.status,
      };
    }),
  };
}

export function dashboardGeoMock() {
  return {
    isDemo: true,
    stats: {
      onlineHosts: 0,
      liveCalls: 0,
      callsPerMinute: 0,
      revenuePerMinute: 0,
    },
    topCountries: [
      { code: 'IN', label: 'India', pct: 42 },
      { code: 'PK', label: 'Pakistan', pct: 18 },
      { code: 'BD', label: 'Bangladesh', pct: 15 },
      { code: 'NP', label: 'Nepal', pct: 8 },
      { code: 'OTHER', label: 'Others', pct: 17 },
    ],
    note: 'Geo distribution is illustrative until country telemetry is stored.',
  };
}
