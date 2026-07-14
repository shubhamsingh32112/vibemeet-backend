/**
 * Composable aggregations for GET /admin/dashboard/* (BFF-style).
 * Caps limits; indexed queries only.
 */
import mongoose from 'mongoose';
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
import { countCreatorPresenceBreakdownPlatform } from '../availability/presence-dashboard.service';
import { parseInrFromPurchaseDescription } from './admin-leaderboards.service';
import { getRazorpayInstance, isRazorpayConfigured } from '../../config/razorpay';
import { logError } from '../../utils/logger';
import {
  formatIstDateTime,
  istDateKey,
  istDateKeysLastNDays,
  istDayBounds,
  istLookbackCalendarDays,
  istRangeMatch,
  istStartOfToday,
  istYesterdayKey,
  iterIstDateBucketDefs,
  IST_TIMEZONE,
  isValidIstDateKey,
} from '../../utils/ist-time';

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
  scope: 'selected_range' | 'realtime' | 'ist_today';
  unit: string;
  definition: string;
  timezoneScope?: 'ist' | 'header_range' | 'realtime';
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
  return istRangeMatch(range.from, range.to);
}

function dateFieldRangeMatch(range: DashboardDateFilter | undefined, field: string): Record<string, unknown> {
  if (!range) return {};
  return { [field]: istRangeMatch(range.from, range.to) };
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
      label: 'Net wallet coin flow (range total)',
      backendField: 'revenueCoinsToday',
      scope: 'selected_range',
      unit: 'coins',
      timezoneScope: 'header_range',
      definition:
        'Completed wallet credits minus completed wallet debits in the header IST range (CoinTransaction.createdAt).',
    },
    revenueDailyBalance: {
      label: 'Recharge collection (today IST)',
      backendField: 'revenueDailyBalance',
      scope: 'ist_today',
      unit: 'INR',
      timezoneScope: 'ist',
      definition:
        'Sum of completed payment_gateway wallet recharges for the current IST calendar day (CoinTransaction.updatedAt). Ignores header date filter.',
    },
    liveCallsProxy: {
      label: 'Live calls (5m proxy)',
      backendField: 'liveCallsProxy',
      scope: 'realtime',
      unit: 'calls',
      timezoneScope: 'realtime',
      definition: 'Count of user-side call history rows created in the trailing 5 minutes (wall clock).',
    },
    totalCallMinutesToday: {
      label: 'Call minutes',
      backendField: 'totalCallMinutesToday',
      scope: 'selected_range',
      unit: 'minutes',
      timezoneScope: 'header_range',
      definition:
        'Sum of user-side call durations in the header IST range (CallHistory.createdAt), converted to minutes.',
    },
    totalCallsToday: {
      label: 'Calls',
      backendField: 'totalCallsToday',
      scope: 'selected_range',
      unit: 'calls',
      timezoneScope: 'header_range',
      definition: 'Total user-side calls created in the header IST range (CallHistory.createdAt).',
    },
    coinsSpentOnCallsToday: {
      label: 'Coins spent on calls',
      backendField: 'coinsSpentOnCallsToday',
      scope: 'selected_range',
      unit: 'coins',
      timezoneScope: 'header_range',
      definition: 'Sum of user-side coins deducted in the header IST range (CallHistory.coinsDeducted).',
    },
    pendingPayouts: {
      label: 'Pending payouts',
      backendField: 'pendingPayouts',
      scope: 'selected_range',
      unit: 'requests',
      timezoneScope: 'header_range',
      definition: 'Pending withdrawal requests with requestedAt in the header IST range.',
    },
    hostsOnline: {
      label: 'Hosts online',
      backendField: 'hostsOnline',
      scope: 'realtime',
      unit: 'hosts',
      timezoneScope: 'realtime',
      definition: 'Live Redis presence: creators available for calls right now.',
    },
  };
}

function walletFlowPointsFromMap(
  byDate: Map<string, { credit: number; debit: number }>,
  range?: DashboardDateFilter
) {
  const toPoint = (date: string, { credit, debit }: { credit: number; debit: number }) => ({
    date,
    creditCoins: credit,
    debitCoins: debit,
    netCoins: credit - debit,
  });

  if (range) {
    return iterIstDateBucketDefs(istDateKey(range.from), istDateKey(new Date(range.to.getTime() - 1))).map(
      ({ key }) => toPoint(key, byDate.get(key) ?? { credit: 0, debit: 0 })
    );
  }

  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, entry]) => toPoint(date, entry));
}

export function rechargeInrFromRow(row: {
  priceInr?: number | null;
  description?: string | null;
  coins?: number;
}): number {
  if (typeof row.priceInr === 'number' && row.priceInr > 0) return row.priceInr;
  const parsed = parseInrFromPurchaseDescription(row.description);
  if (parsed > 0) return parsed;
  return 0;
}

const RECHARGE_MATCH = {
  type: 'credit' as const,
  source: 'payment_gateway' as const,
  status: 'completed' as const,
} as const;

function rechargeUserLabel(
  user: { username?: string; email?: string; phone?: string } | null | undefined,
  userId: string
): string {
  const username = user?.username?.trim();
  if (username) return username;
  const email = user?.email?.trim();
  if (email) return email;
  const phone = user?.phone?.trim();
  if (phone) return phone;
  return userId;
}

export async function dashboardRechargeDailySeries(days: number) {
  const historyDays = Math.min(90, Math.max(1, days));
  const dateKeys = istDateKeysLastNDays(historyDays);
  const windowStart = istDayBounds(dateKeys[0]).start;

  const rows = await CoinTransaction.find({
    ...RECHARGE_MATCH,
    updatedAt: { $gte: windowStart },
  })
    .select('updatedAt coins priceInr description')
    .lean();

  const byDate = new Map<string, { rechargeInr: number; rechargeCoins: number; transactionCount: number }>();
  for (const row of rows) {
    const date = istDateKey(row.updatedAt);
    const entry = byDate.get(date) ?? { rechargeInr: 0, rechargeCoins: 0, transactionCount: 0 };
    entry.rechargeInr += rechargeInrFromRow(row);
    entry.rechargeCoins += row.coins ?? 0;
    entry.transactionCount += 1;
    byDate.set(date, entry);
  }

  const points = dateKeys.map((date) => {
    const entry = byDate.get(date) ?? { rechargeInr: 0, rechargeCoins: 0, transactionCount: 0 };
    return { date, ...entry };
  });

  return {
    points,
    timezone: IST_TIMEZONE,
    historyDays,
    note: 'Successful wallet recharges (payment_gateway credits) per IST day in INR. Timestamps use payment completion (updatedAt).',
  };
}

async function sumRechargeInrForIstDay(istDate: string): Promise<number> {
  const { start, end } = istDayBounds(istDate);
  const rows = await CoinTransaction.find({
    ...RECHARGE_MATCH,
    updatedAt: { $gte: start, $lt: end },
  })
    .select('priceInr description')
    .lean();
  return rows.reduce((sum, row) => sum + rechargeInrFromRow(row), 0);
}

export async function dashboardRechargeTransactionsForDay(istDate: string) {
  if (!isValidIstDateKey(istDate)) {
    throw new Error('INVALID_IST_DATE');
  }

  const { start, end } = istDayBounds(istDate);
  const rows = await CoinTransaction.find({
    ...RECHARGE_MATCH,
    updatedAt: { $gte: start, $lt: end },
  })
    .sort({ updatedAt: -1 })
    .populate({ path: 'userId', select: 'username email phone' })
    .select(
      'transactionId userId coins priceInr description paymentGatewayOrderId paymentGatewayTransactionId updatedAt'
    )
    .lean();

  const transactions = rows.map((row) => {
    const user = row.userId as
      | { _id?: mongoose.Types.ObjectId; username?: string; email?: string; phone?: string }
      | mongoose.Types.ObjectId
      | null
      | undefined;
    const userId =
      user && typeof user === 'object' && '_id' in user && user._id
        ? user._id.toString()
        : user?.toString?.() ?? '';
    const userObj = user && typeof user === 'object' && 'username' in user ? user : null;

    return {
      id: row._id.toString(),
      completedAt: row.updatedAt.toISOString(),
      completedAtIst: formatIstDateTime(row.updatedAt),
      userId,
      userLabel: rechargeUserLabel(userObj, userId),
      inr: rechargeInrFromRow(row),
      coins: row.coins ?? 0,
      description: row.description ?? null,
      orderId: row.paymentGatewayOrderId ?? null,
      paymentId: row.paymentGatewayTransactionId ?? null,
      transactionId: row.transactionId,
    };
  });

  const totalInr = transactions.reduce((sum, row) => sum + row.inr, 0);

  return {
    date: istDate,
    timezone: IST_TIMEZONE,
    totalInr,
    totalCoins: transactions.reduce((sum, row) => sum + row.coins, 0),
    transactionCount: transactions.length,
    transactions,
  };
}

export async function dashboardWalletFlowSeries(days: number, range?: DashboardDateFilter) {
  const d = Math.min(90, Math.max(1, days));
  let createdAt: Record<string, Date>;
  if (range) {
    createdAt = createdAtRangeMatch(range);
  } else {
    const { from } = istLookbackCalendarDays(d);
    createdAt = { $gte: from };
  }

  const agg = await CoinTransaction.aggregate<{
    _id: { date: string; type: string };
    total: number;
  }>([
    { $match: { createdAt, status: 'completed' } },
    {
      $group: {
        _id: {
          date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: IST_TIMEZONE } },
          type: '$type',
        },
        total: { $sum: '$coins' },
      },
    },
    { $sort: { '_id.date': 1 } },
  ]);

  const byDate = new Map<string, { credit: number; debit: number }>();
  for (const row of agg) {
    const date = row._id.date;
    const entry = byDate.get(date) ?? { credit: 0, debit: 0 };
    if (row._id.type === 'credit') entry.credit += row.total;
    else if (row._id.type === 'debit') entry.debit += row.total;
    byDate.set(date, entry);
  }

  return {
    points: walletFlowPointsFromMap(byDate, range),
    timezone: IST_TIMEZONE,
    note: range
      ? 'Net wallet coin flow per IST day (credits minus debits) for each day in the selected range.'
      : 'Net wallet coin flow per IST day (credits minus debits).',
    selectedRange: selectedRangePayload(range),
  };
}

export async function dashboardOverviewPayload(range?: DashboardDateFilter) {
  const istTodayStart = istStartOfToday();
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const selectedCreatedAt = range ? createdAtRangeMatch(range) : { $gte: istTodayStart };

  const pendingPayoutsMatch = {
    status: 'pending' as const,
    ...(range ? dateFieldRangeMatch(range, 'requestedAt') : {}),
  };

  const [
    presenceBreakdown,
    agencyCount,
    bdCount,
    pendingWithdrawals,
    callTodayAgg,
    coinFlowToday,
    recentCalls5m,
    activeZeroDuration,
    rechargeDailySeries,
  ] = await Promise.all([
    countCreatorPresenceBreakdownPlatform(),
    User.countDocuments({ role: 'agency' }),
    User.countDocuments(TOP_BD_ROLE),
    Withdrawal.countDocuments(pendingPayoutsMatch),
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
    dashboardRechargeDailySeries(90),
  ]);

  const todayIst = istDateKey(new Date());
  const yesterdayIst = istYesterdayKey();

  const [rechargeCollectionTodayInr, rechargeCollectionYesterdayInr] = await Promise.all([
    sumRechargeInrForIstDay(todayIst),
    sumRechargeInrForIstDay(yesterdayIst),
  ]);

  const callT = callTodayAgg[0] || { totalCalls: 0, totalDurationSec: 0, totalCoinsSpent: 0 };
  const credits = coinFlowToday.find((r: { _id: string }) => r._id === 'credit');
  const debits = coinFlowToday.find((r: { _id: string }) => r._id === 'debit');
  const revenueCoinsToday = (credits?.total ?? 0) - (debits?.total ?? 0);
  const rangeLabel = range ? 'selected IST range' : 'today (IST)';

  return {
    revenueCoinsToday,
    revenueCoinsTodayNote: `Net completed wallet coin flow for ${rangeLabel} (credits minus debits).`,
    revenueDailyBalance: rechargeCollectionTodayInr,
    revenueDailyBalanceNote: `Successful recharges today (${todayIst} IST). Yesterday: ₹${rechargeCollectionYesterdayInr.toLocaleString('en-IN')}. Tap for daily INR history.`,
    rechargeCollectionTodayInr,
    rechargeCollectionYesterdayInr,
    rechargeDailySeries,
    liveCallsProxy: recentCalls5m,
    activeUnsettledUserCalls: activeZeroDuration,
    onlineHosts: presenceBreakdown.online,
    hostsOnline: presenceBreakdown.online,
    hostsOnCall: presenceBreakdown.onCall,
    hostsOffline: presenceBreakdown.offline,
    hostsTotal: presenceBreakdown.total,
    presenceNote:
      'Live Redis presence: online = available for calls, on_call = active video call, offline = unavailable.',
    totalAgencies: agencyCount,
    totalBds: bdCount,
    pendingPayouts: pendingWithdrawals,
    pendingPayoutsNote: range
      ? `Pending withdrawals requested in the selected IST range.`
      : `All pending withdrawal requests (no date filter).`,
    walletFlowSeries: rechargeDailySeries,
    totalCallMinutesToday: Math.round((callT.totalDurationSec / 60) * 100) / 100,
    totalCallsToday: callT.totalCalls,
    coinsSpentOnCallsToday: callT.totalCoinsSpent,
    growthPlaceholder: { revenuePct: null, callsPct: null, hostsPct: null },
    selectedRange: selectedRangePayload(range),
    timezone: IST_TIMEZONE,
    rangeSemantics: 'half_open_ist',
    metricContract: buildOverviewMetricContract(),
    generatedAt: new Date().toISOString(),
  };
}

export async function dashboardRevenueSeries(days: number, range?: DashboardDateFilter) {
  const d = Math.min(90, Math.max(1, days));
  let createdAt: Record<string, Date>;
  let dateKeys: string[];
  if (range) {
    createdAt = createdAtRangeMatch(range);
    dateKeys = iterIstDateBucketDefs(istDateKey(range.from), istDateKey(new Date(range.to.getTime() - 1))).map(
      (b) => b.key
    );
  } else {
    const { from } = istLookbackCalendarDays(d);
    createdAt = { $gte: from };
    dateKeys = istDateKeysLastNDays(d);
  }

  const agg = await CallHistory.aggregate<{ _id: string; revenue: number; commission: number }>([
    { $match: { createdAt, ownerRole: 'user' } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: IST_TIMEZONE } },
        revenue: { $sum: '$coinsDeducted' },
        commission: { $sum: 0 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const byDate = new Map(agg.map((r) => [r._id, r]));

  return {
    points: dateKeys.map((date) => ({
      date,
      revenueCoins: byDate.get(date)?.revenue ?? 0,
      commissionCoins: byDate.get(date)?.commission ?? 0,
    })),
    timezone: IST_TIMEZONE,
    note: range
      ? 'Call revenue (coins deducted) per IST day inside the selected range.'
      : 'Call revenue (coins deducted) per IST day.',
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
    .select('callId ownerUserId otherName otherAvatar durationSeconds coinsEarned createdAt')
    .lean();

  const ownerUserIds = [
    ...new Set(
      rows
        .map((r) => r.ownerUserId?.toString())
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    ),
  ];
  const creators =
    ownerUserIds.length === 0
      ? []
      : await Creator.find({ userId: { $in: ownerUserIds.map((id) => new mongoose.Types.ObjectId(id)) } })
          .select('name userId _id')
          .lean();
  const creatorByUserId = new Map(creators.map((c) => [c.userId?.toString() ?? '', c]));

  return {
    calls: rows.map((r) => {
      const ownerUserId = r.ownerUserId?.toString() ?? '';
      const creator = creatorByUserId.get(ownerUserId);
      return {
        callId: r.callId,
        hostName: creator?.name ?? 'Host',
        hostId: creator?._id?.toString() ?? null,
        callerName: r.otherName,
        durationSeconds: r.durationSeconds,
        revenueCoins: r.coinsEarned ?? 0,
        startedAt: r.createdAt,
      };
    }),
    note: 'Recent creator-side call rows (last 30m). Host name is the creator; caller is the user. Not a substitute for Stream session truth.',
  };
}

export async function dashboardRealtimePayload() {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const [presenceBreakdown, pendingWithdrawals, openSupportTickets, recentCalls5m, activeBillingSessions] =
    await Promise.all([
      countCreatorPresenceBreakdownPlatform(),
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
    onlineCreators: presenceBreakdown.online,
    hostsOnline: presenceBreakdown.online,
    hostsOnCall: presenceBreakdown.onCall,
    hostsOffline: presenceBreakdown.offline,
    hostsTotal: presenceBreakdown.total,
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
  const { creatorStatsByUserId } = await aggregateCreatorPerformanceInRange(range);

  const rankedStats = [...creatorStatsByUserId.entries()]
    .map(([ownerUserId, stat]) => ({
      ownerUserId,
      calls: stat.calls,
      minutes: stat.minutes,
      earningsCoins: stat.earnings,
    }))
    .sort((a, b) => b.earningsCoins - a.earningsCoins || b.calls - a.calls)
    .slice(0, lim);

  const topUserIds = rankedStats
    .map((r) => r.ownerUserId)
    .filter((id) => id.length > 0)
    .map((id) => new mongoose.Types.ObjectId(id));

  const creatorRows =
    topUserIds.length > 0
      ? await Creator.find({ userId: { $in: topUserIds } })
          .select('name earningsCoins userId avatar')
          .lean()
      : [];
  const creatorByUserId = new Map(creatorRows.map((c) => [c.userId?.toString() ?? '', c]));

  const ranked = rankedStats
    .map((stat) => {
      const creator = creatorByUserId.get(stat.ownerUserId);
      if (!creator) return null;
      return {
        creator,
        calls: stat.calls,
        minutes: stat.minutes,
        earningsCoins: stat.earningsCoins,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

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
  const { from: defaultFrom } = istLookbackCalendarDays(30);
  const createdAt = range ? createdAtRangeMatch(range) : { $gte: istStartOfToday() };
  const volumeCreatedAt = range ? createdAtRangeMatch(range) : { $gte: defaultFrom };

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
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: IST_TIMEZONE } },
          c: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const t = todayAgg[0] || { total: 0, answered: 0, missed: 0, avgDur: 0 };
  const volumeByDate = new Map(monthAgg.map((r) => [r._id, r.c]));
  const volumeKeys = range
    ? iterIstDateBucketDefs(istDateKey(range.from), istDateKey(new Date(range.to.getTime() - 1))).map((b) => b.key)
    : istDateKeysLastNDays(30);

  return {
    today: {
      totalCalls: t.total,
      answeredCalls: t.answered,
      missedCalls: t.missed,
      avgCallDurationSec: Math.round(t.avgDur || 0),
    },
    dailyVolume: volumeKeys.map((date) => ({ date, calls: volumeByDate.get(date) ?? 0 })),
    timezone: IST_TIMEZONE,
    selectedRange: selectedRangePayload(range),
  };
}

export async function dashboardPayouts(limit: number, range?: DashboardDateFilter) {
  const lim = clampDashboardLimit(limit, 25);
  const rows = await Withdrawal.find({
    status: 'pending',
    ...(range ? dateFieldRangeMatch(range, 'requestedAt') : {}),
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
