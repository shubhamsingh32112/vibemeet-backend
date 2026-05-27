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
import axios from 'axios';
import { buildAvatarUrls } from '../images/image-url';
import type { IImageAsset } from '../images/image-asset.schema';
import { countOnlineCreatorsPlatform } from '../availability/presence-dashboard.service';
import { getRazorpayInstance, isRazorpayConfigured } from '../../config/razorpay';
import { logError } from '../../utils/logger';

const TOP_BD_ROLE = { role: 'bd' as const };
const MIDDLE_AGENCY_ROLE = { role: 'agency' as const };
const MAX = 100;

export type DashboardDateFilter = {
  from: Date;
  to: Date;
  fromIso?: string;
  toIso?: string;
};

type DashboardMetricDefinition = {
  label: string;
  backendField: string;
  scope: 'selected_range' | 'realtime';
  unit: string;
  definition: string;
};

type RazorpayBalanceBucket = {
  key: string;
  channelLabel: string;
  currency: string;
  available: number;
  onHold: number;
  pending: number;
  reserved: number;
  settled: number;
  net: number;
  raw: Record<string, unknown>;
};

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

function createdAtRangeMatch(range?: DashboardDateFilter): Record<string, Date> {
  if (!range) return {};
  return { $gte: range.from, $lte: range.to };
}

function selectedRangePayload(range?: DashboardDateFilter): { from: string; to: string } | undefined {
  if (!range) return undefined;
  return {
    from: (range.fromIso ?? range.from.toISOString()),
    to: (range.toIso ?? range.to.toISOString()),
  };
}

function buildOverviewMetricContract(): Record<string, DashboardMetricDefinition> {
  return {
    revenueCoinsToday: {
      label: 'Net wallet coin flow',
      backendField: 'revenueCoinsToday',
      scope: 'selected_range',
      unit: 'coins',
      definition: 'Completed wallet credits minus completed wallet debits in the selected time window.',
    },
    liveCallsProxy: {
      label: 'Live calls (5m proxy)',
      backendField: 'liveCallsProxy',
      scope: 'realtime',
      unit: 'calls',
      definition: 'Count of user-side call history rows created in the trailing 5 minutes.',
    },
    totalCallMinutesToday: {
      label: 'Call minutes',
      backendField: 'totalCallMinutesToday',
      scope: 'selected_range',
      unit: 'minutes',
      definition: 'Sum of user-side call durations in the selected time window, converted to minutes.',
    },
    totalCallsToday: {
      label: 'Calls',
      backendField: 'totalCallsToday',
      scope: 'selected_range',
      unit: 'calls',
      definition: 'Total user-side calls created in the selected time window.',
    },
    coinsSpentOnCallsToday: {
      label: 'Coins spent on calls',
      backendField: 'coinsSpentOnCallsToday',
      scope: 'selected_range',
      unit: 'coins',
      definition: 'Sum of user-side coins deducted from call history in the selected time window.',
    },
  };
}

export async function dashboardOverviewPayload(range?: DashboardDateFilter) {
  const today = utcStartOfDay();
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const selectedCreatedAt = range ? createdAtRangeMatch(range) : { $gte: today };

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
      { $match: { createdAt: selectedCreatedAt, ownerRole: 'user' } },
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
      { $match: { createdAt: selectedCreatedAt, status: 'completed' } },
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
  const rangeLabel = range ? 'selected range' : 'today (UTC)';

  return {
    revenueCoinsToday,
    revenueCoinsTodayNote: `Net completed wallet coin flow for ${rangeLabel} (credits minus debits).`,
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
    selectedRange: selectedRangePayload(range),
    metricContract: buildOverviewMetricContract(),
    generatedAt: new Date().toISOString(),
  };
}

export async function dashboardRevenueSeries(days: number, range?: DashboardDateFilter) {
  const d = Math.min(90, Math.max(1, days));
  const from = range ? new Date(range.from) : new Date();
  if (!range) {
    from.setUTCHours(0, 0, 0, 0);
    from.setUTCDate(from.getUTCDate() - (d - 1));
  }
  const createdAt = range ? createdAtRangeMatch(range) : { $gte: from };

  const agg = await CallHistory.aggregate<{ _id: string; revenue: number; commission: number }>([
    { $match: { createdAt, ownerRole: 'user' } },
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
    note: range
      ? 'Revenue series uses user-side call history coins deducted per UTC day inside the selected range.'
      : 'Revenue series uses user-side call history coins deducted per UTC day.',
    selectedRange: selectedRangePayload(range),
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

async function aggregateCreatorPerformanceInRange(range?: DashboardDateFilter) {
  const createdAt = createdAtRangeMatch(range);
  const creatorStats = await CallHistory.aggregate<{
    _id: import('mongoose').Types.ObjectId;
    calls: number;
    minutes: number;
    earnings: number;
  }>([
    { $match: { ownerRole: 'creator', ...(range ? { createdAt } : {}) } },
    {
      $group: {
        _id: '$ownerUserId',
        calls: { $sum: 1 },
        minutes: { $sum: { $divide: ['$durationSeconds', 60] } },
        earnings: { $sum: '$coinsEarned' },
      },
    },
  ]);

  if (creatorStats.length === 0) {
    return {
      creatorStatsByUserId: new Map<string, { calls: number; minutes: number; earnings: number }>(),
      agencyRevenueByAgencyId: new Map<string, number>(),
      callCountByAgencyId: new Map<string, number>(),
    };
  }

  const ownerUserIds = creatorStats.map((row) => row._id);
  const creators = await Creator.find({ userId: { $in: ownerUserIds } })
    .select('_id userId assignedAgencyId')
    .lean();
  const creatorByUserId = new Map(creators.map((c) => [c.userId?.toString() ?? '', c]));

  const creatorStatsByUserId = new Map<string, { calls: number; minutes: number; earnings: number }>();
  const agencyRevenueByAgencyId = new Map<string, number>();
  const callCountByAgencyId = new Map<string, number>();

  for (const row of creatorStats) {
    const ownerUserId = row._id.toString();
    creatorStatsByUserId.set(ownerUserId, {
      calls: row.calls ?? 0,
      minutes: row.minutes ?? 0,
      earnings: row.earnings ?? 0,
    });

    const creator = creatorByUserId.get(ownerUserId);
    const agencyId = creator?.assignedAgencyId?.toString();
    if (!agencyId) continue;
    agencyRevenueByAgencyId.set(agencyId, (agencyRevenueByAgencyId.get(agencyId) ?? 0) + (row.earnings ?? 0));
    callCountByAgencyId.set(agencyId, (callCountByAgencyId.get(agencyId) ?? 0) + (row.calls ?? 0));
  }

  return { creatorStatsByUserId, agencyRevenueByAgencyId, callCountByAgencyId };
}

export async function dashboardTopHosts(limit: number, range?: DashboardDateFilter) {
  const lim = clampDashboardLimit(limit, 10);
  const rows = await Creator.find({})
    .select('name earningsCoins userId avatar')
    .lean();
  const { creatorStatsByUserId } = await aggregateCreatorPerformanceInRange(range);

  const ranked = rows
    .map((c) => {
      const ownerUserId = c.userId?.toString() ?? '';
      const stat = creatorStatsByUserId.get(ownerUserId);
      return {
        creator: c,
        calls: stat?.calls ?? 0,
        minutes: stat?.minutes ?? 0,
        earningsCoins: stat?.earnings ?? 0,
      };
    })
    .sort((a, b) => b.earningsCoins - a.earningsCoins || b.calls - a.calls)
    .slice(0, lim);

  return {
    rows: ranked.map((row, i) => {
      const c = row.creator;
      return {
        rank: i + 1,
        host: c.name || c.userId?.toString() || c._id.toString(),
        creatorId: c._id.toString(),
        avatarUrl: dashboardCreatorAvatarSmUrl(c.avatar as IImageAsset | null | undefined),
        minutes: Math.round(row.minutes * 100) / 100,
        calls: row.calls,
        earningsCoins: row.earningsCoins,
      };
    }),
    note: range
      ? 'Host ranking is based on creator-side call earnings within the selected range.'
      : 'Host ranking is based on creator-side call earnings (all time).',
    selectedRange: selectedRangePayload(range),
  };
}

export async function dashboardTopBds(limit: number, range?: DashboardDateFilter) {
  const lim = clampDashboardLimit(limit, 10);
  const bds = await User.find(TOP_BD_ROLE)
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
  const { agencyRevenueByAgencyId } = await aggregateCreatorPerformanceInRange(range);

  const rankedRows = bds
    .map((b) => {
      const childAgencies = agenciesByBd.filter((a) => a.bdId?.toString() === b._id.toString());
      const hostTotal = childAgencies.reduce(
        (sum, a) => sum + (hostsByAgency.get(a._id.toString()) ?? 0),
        0
      );
      const revenueCoins = childAgencies.reduce(
        (sum, a) => sum + (agencyRevenueByAgencyId.get(a._id.toString()) ?? 0),
        0
      );
      return {
        bdName: b.displayName || b.email || b._id.toString(),
        agencies: childAgencies.length,
        hosts: hostTotal,
        revenueCoins,
        commissionCoins: 0,
      };
    })
    .sort((a, b) => b.revenueCoins - a.revenueCoins || b.hosts - a.hosts)
    .slice(0, lim)
    .map((row, idx) => ({ rank: idx + 1, ...row }));

  return {
    rows: rankedRows,
    note: range
      ? 'BD ranking uses rollup of creator-side earnings from agencies in the selected range.'
      : 'BD ranking uses rollup of creator-side earnings from agencies (all time).',
    selectedRange: selectedRangePayload(range),
  };
}

export async function dashboardTopAgencies(limit: number, range?: DashboardDateFilter) {
  const lim = clampDashboardLimit(limit, 10);
  const agencies = await User.find(MIDDLE_AGENCY_ROLE)
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
  const { agencyRevenueByAgencyId } = await aggregateCreatorPerformanceInRange(range);

  return {
    rows: agencies
      .map((a) => ({
        agencyName: a.displayName || a.email || a._id.toString(),
        bds: a.bdId ? 1 : 0,
        hosts: hostsPerAgency.get(a._id.toString()) ?? 0,
        revenueCoins: agencyRevenueByAgencyId.get(a._id.toString()) ?? 0,
        parentBdId: a.bdId?.toString() ?? null,
      }))
      .sort((a, b) => b.revenueCoins - a.revenueCoins || b.hosts - a.hosts)
      .slice(0, lim)
      .map((row, idx) => ({ rank: idx + 1, ...row })),
    note: range
      ? 'Agency ranking uses creator-side earnings in the selected range.'
      : 'Agency ranking uses creator-side earnings (all time).',
    selectedRange: selectedRangePayload(range),
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

export async function dashboardCallAnalytics(range?: DashboardDateFilter) {
  const today = utcStartOfDay();
  const thirty = new Date(today);
  thirty.setUTCDate(thirty.getUTCDate() - 30);
  const createdAt = range ? createdAtRangeMatch(range) : { $gte: today };
  const volumeCreatedAt = range ? createdAtRangeMatch(range) : { $gte: thirty };

  const [todayAgg, monthAgg] = await Promise.all([
    CallHistory.aggregate([
      { $match: { createdAt, ownerRole: 'user' } },
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
      { $match: { createdAt: volumeCreatedAt, ownerRole: 'user' } },
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
    selectedRange: selectedRangePayload(range),
  };
}

export async function dashboardPayouts(limit: number, range?: DashboardDateFilter) {
  const lim = clampDashboardLimit(limit, 25);
  const rows = await Withdrawal.find({
    status: 'pending',
    ...(range ? { requestedAt: createdAtRangeMatch(range) } : {}),
  })
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
    selectedRange: selectedRangePayload(range),
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

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeChannelLabel(input: string | null | undefined): string {
  const v = String(input ?? '').trim().toLowerCase();
  if (!v) return 'Overall';
  if (v.includes('online')) return 'Online';
  if (v.includes('in-person') || v.includes('inperson') || v.includes('pos')) return 'In-Person';
  if (v.includes('international') || v.includes('apm')) return 'APM International';
  return input ?? 'Other';
}

function extractBalanceRows(rawBalance: unknown): RazorpayBalanceBucket[] {
  if (!rawBalance || typeof rawBalance !== 'object') return [];
  const obj = rawBalance as Record<string, unknown>;
  const itemsRaw = Array.isArray(obj.items) ? obj.items : [];
  const rows = itemsRaw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item, idx) => {
      const currency = String(item.currency ?? 'INR').toUpperCase();
      const channelRaw =
        typeof item.channel === 'string'
          ? item.channel
          : typeof item.channel_type === 'string'
            ? item.channel_type
            : typeof item.type === 'string'
              ? item.type
              : null;
      const channelLabel = normalizeChannelLabel(channelRaw);
      const available = toNumber(item.available) ?? 0;
      const onHold = toNumber(item.on_hold) ?? toNumber(item.onHold) ?? 0;
      const pending = toNumber(item.pending) ?? 0;
      const reserved = toNumber(item.reserved) ?? toNumber(item.reserve) ?? 0;
      const settled = toNumber(item.settled) ?? 0;
      const net = toNumber(item.balance) ?? available - onHold;
      const key = `${channelLabel}-${currency}-${idx}`;
      return {
        key,
        channelLabel,
        currency,
        available,
        onHold,
        pending,
        reserved,
        settled,
        net,
        raw: item,
      };
    });

  if (rows.length > 0) return rows;

  const fallbackCurrency = String(obj.currency ?? 'INR').toUpperCase();
  const available = toNumber(obj.available) ?? 0;
  const onHold = toNumber(obj.on_hold) ?? toNumber(obj.onHold) ?? 0;
  const pending = toNumber(obj.pending) ?? 0;
  const reserved = toNumber(obj.reserved) ?? toNumber(obj.reserve) ?? 0;
  const settled = toNumber(obj.settled) ?? 0;
  const net = toNumber(obj.balance) ?? available - onHold;
  return [
    {
      key: `Overall-${fallbackCurrency}`,
      channelLabel: 'Overall',
      currency: fallbackCurrency,
      available,
      onHold,
      pending,
      reserved,
      settled,
      net,
      raw: obj,
    },
  ];
}

export async function dashboardRazorpayBalance() {
  if (!isRazorpayConfigured()) {
    return {
      configured: false,
      fetchedAt: new Date().toISOString(),
      note: 'RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET are missing on this backend environment.',
      fetchError: null as string | null,
      totals: {
        currency: 'INR',
        available: 0,
        onHold: 0,
        pending: 0,
        reserved: 0,
        settled: 0,
        net: 0,
      },
      hasNegativeAvailable: false,
      maxNegativeLimit: 0,
      channels: [] as RazorpayBalanceBucket[],
      raw: null as unknown,
    };
  }

  try {
    const sdk = getRazorpayInstance() as unknown as { balance?: { fetch: () => Promise<unknown> } };
    let balance: unknown;

    if (sdk.balance?.fetch) {
      balance = await sdk.balance.fetch();
    } else {
      const keyId = String(process.env.RAZORPAY_KEY_ID ?? '');
      const keySecret = String(process.env.RAZORPAY_KEY_SECRET ?? '');
      const response = await axios.get('https://api.razorpay.com/v1/balance', {
        auth: { username: keyId, password: keySecret },
        timeout: 15_000,
      });
      balance = response.data;
    }

    const channels = extractBalanceRows(balance);
    const total = channels.reduce(
      (acc, row) => ({
        available: acc.available + row.available,
        onHold: acc.onHold + row.onHold,
        pending: acc.pending + row.pending,
        reserved: acc.reserved + row.reserved,
        settled: acc.settled + row.settled,
        net: acc.net + row.net,
      }),
      { available: 0, onHold: 0, pending: 0, reserved: 0, settled: 0, net: 0 }
    );

    return {
      configured: true,
      fetchedAt: new Date().toISOString(),
      note: 'Balances are fetched live from Razorpay. Reserve/max-negative depends on your account configuration.',
      fetchError: null as string | null,
      totals: {
        currency: channels[0]?.currency ?? 'INR',
        ...total,
      },
      hasNegativeAvailable: total.available < 0,
      maxNegativeLimit: total.reserved,
      channels,
      raw: balance as unknown,
    };
  } catch (error) {
    logError('dashboardRazorpayBalance failed', error as Error);
    const axiosStatus =
      typeof error === 'object' && error && 'response' in error
        ? Number((error as { response?: { status?: number } }).response?.status ?? 0)
        : 0;
    const fetchError =
      axiosStatus === 401
        ? 'Razorpay auth failed (401). Verify KEY_ID/KEY_SECRET and test/live mode match.'
        : 'Unable to fetch balance from Razorpay at the moment.';

    return {
      configured: true,
      fetchedAt: new Date().toISOString(),
      note: 'Razorpay balance fetch failed; showing empty fallback values.',
      fetchError,
      totals: {
        currency: 'INR',
        available: 0,
        onHold: 0,
        pending: 0,
        reserved: 0,
        settled: 0,
        net: 0,
      },
      hasNegativeAvailable: false,
      maxNegativeLimit: 0,
      channels: [] as RazorpayBalanceBucket[],
      raw: null as unknown,
    };
  }
}
