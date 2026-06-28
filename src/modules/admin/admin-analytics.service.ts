/**
 * Admin analytics BFF — accurate aggregates for super-admin revamp.
 */
import mongoose from 'mongoose';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { CallHistory } from '../billing/call-history.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { StaffWalletLedger } from '../billing/staff-wallet-ledger.model';
import { Withdrawal } from '../creator/withdrawal.model';
import { MomentPurchase } from '../moments/models/moment-purchase.model';
import { VipMembership } from '../vip/models/vip-membership.model';
import { MomentsPremiumMembership } from '../moments-premium/models/moments-premium-membership.model';
import { isBdRole, isAgencyRole } from '../../utils/staff-roles';
import { parseInrFromPurchaseDescription } from './admin-leaderboards.service';
import { getRedis } from '../../config/redis';
import { UserLoginEvent } from '../user/user-login-event.model';

export type AnalyticsPeriod = 'today' | '7d' | '30d';
export type UserLoginGranularity = 'daily' | 'weekly' | 'monthly';
export type UserSignupGranularity = 'hourly' | 'daily';

function utcStartOfDay(d = new Date()): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

export function periodToRange(period: AnalyticsPeriod): { from: Date; to: Date } {
  const to = new Date();
  const from = utcStartOfDay();
  if (period === '7d') {
    from.setUTCDate(from.getUTCDate() - 6);
  } else if (period === '30d') {
    from.setUTCDate(from.getUTCDate() - 29);
  }
  return { from, to };
}

export async function usersSummaryPayload() {
  const now = new Date();
  const todayStart = utcStartOfDay(now);
  const d7 = new Date(now.getTime() - 7 * 86400000);
  const d30 = new Date(now.getTime() - 30 * 86400000);
  const userRole = { role: 'user' as const };

  const [totalUsers, signupsToday, signups7d, signups30d, onboardedUsers] = await Promise.all([
    User.countDocuments(userRole),
    User.countDocuments({ ...userRole, createdAt: { $gte: todayStart } }),
    User.countDocuments({ ...userRole, createdAt: { $gte: d7 } }),
    User.countDocuments({ ...userRole, createdAt: { $gte: d30 } }),
    User.countDocuments({ ...userRole, categories: { $exists: true, $ne: [] } }),
  ]);

  return {
    totalUsers,
    signupsToday,
    signups7d,
    signups30d,
    onboardedUsers,
    generatedAt: now.toISOString(),
  };
}

function parseUserLoginGranularity(raw: unknown): UserLoginGranularity {
  const g = String(raw ?? 'daily');
  if (g === 'weekly' || g === 'monthly') return g;
  return 'daily';
}

function loginSeriesLookback(granularity: UserLoginGranularity): { from: Date; to: Date } {
  const to = new Date();
  const from = utcStartOfDay(to);
  if (granularity === 'daily') {
    from.setUTCDate(from.getUTCDate() - 29);
    return { from, to };
  }
  if (granularity === 'weekly') {
    from.setUTCDate(from.getUTCDate() - 7 * 11);
    return { from, to };
  }
  from.setUTCMonth(from.getUTCMonth() - 11);
  from.setUTCDate(1);
  return { from, to };
}

function iterUtcDateStrings(from: Date, to: Date): string[] {
  const dates: string[] = [];
  const cur = new Date(from);
  cur.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(0, 0, 0, 0);
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

function isoWeekLabel(year: number, week: number): string {
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function isoWeekStartUtc(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const day = jan4.getUTCDay() || 7;
  const mondayWeek1 = new Date(jan4);
  mondayWeek1.setUTCDate(jan4.getUTCDate() - day + 1);
  const start = new Date(mondayWeek1);
  start.setUTCDate(mondayWeek1.getUTCDate() + (week - 1) * 7);
  return start;
}

function iterWeeklyBuckets(from: Date, to: Date): Array<{ key: string; label: string; startDate: string }> {
  const buckets: Array<{ key: string; label: string; startDate: string }> = [];
  const cur = utcStartOfDay(from);
  const end = utcStartOfDay(to);
  while (cur <= end) {
    const year = cur.getUTCFullYear();
    const week = getUtcIsoWeek(cur);
    const key = isoWeekLabel(year, week);
    if (!buckets.some((b) => b.key === key)) {
      buckets.push({
        key,
        label: key,
        startDate: isoWeekStartUtc(year, week).toISOString().slice(0, 10),
      });
    }
    cur.setUTCDate(cur.getUTCDate() + 7);
  }
  return buckets.slice(-12);
}

function getUtcIsoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function iterMonthlyBuckets(from: Date, to: Date): Array<{ key: string; label: string; startDate: string }> {
  const buckets: Array<{ key: string; label: string; startDate: string }> = [];
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  while (cur <= end) {
    const key = `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}`;
    buckets.push({
      key,
      label: key,
      startDate: cur.toISOString().slice(0, 10),
    });
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return buckets.slice(-12);
}

export async function usersLoginSeriesPayload(granularityInput: unknown) {
  const granularity = parseUserLoginGranularity(granularityInput);
  const { from, to } = loginSeriesLookback(granularity);

  const bucketGroupId =
    granularity === 'daily'
      ? { $dateToString: { format: '%Y-%m-%d', date: '$loggedInAt', timezone: 'UTC' } }
      : granularity === 'weekly'
        ? {
            year: { $isoWeekYear: '$loggedInAt' },
            week: { $isoWeek: '$loggedInAt' },
          }
        : { $dateToString: { format: '%Y-%m', date: '$loggedInAt', timezone: 'UTC' } };

  const agg = await UserLoginEvent.aggregate<{
    _id: string | { year: number; week: number };
    uniqueLogins: number;
    loginEvents: number;
  }>([
    { $match: { role: 'user', loggedInAt: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: bucketGroupId,
        users: { $addToSet: '$userId' },
        loginEvents: { $sum: 1 },
      },
    },
    {
      $project: {
        uniqueLogins: { $size: '$users' },
        loginEvents: 1,
      },
    },
  ]);

  const statsByBucket = new Map<string, { uniqueLogins: number; loginEvents: number }>();
  for (const row of agg) {
    const key =
      typeof row._id === 'string'
        ? row._id
        : isoWeekLabel(row._id.year, row._id.week);
    statsByBucket.set(key, {
      uniqueLogins: row.uniqueLogins ?? 0,
      loginEvents: row.loginEvents ?? 0,
    });
  }

  const bucketDefs =
    granularity === 'daily'
      ? iterUtcDateStrings(from, to).map((date) => ({ key: date, label: date, startDate: date }))
      : granularity === 'weekly'
        ? iterWeeklyBuckets(from, to)
        : iterMonthlyBuckets(from, to);

  const points = bucketDefs.map(({ key, label, startDate }) => {
    const stat = statsByBucket.get(key);
    return {
      label,
      startDate,
      uniqueLogins: stat?.uniqueLogins ?? 0,
      loginEvents: stat?.loginEvents ?? 0,
    };
  });

  return {
    granularity,
    from: from.toISOString(),
    to: to.toISOString(),
    points,
    note:
      'Unique end-users (role=user) who logged in per period. Data is recorded from deployment of login tracking onward.',
    generatedAt: new Date().toISOString(),
  };
}

function parseUserSignupGranularity(raw: unknown): UserSignupGranularity {
  const g = String(raw ?? 'hourly');
  return g === 'daily' ? 'daily' : 'hourly';
}

function iterUtcHourBuckets(from: Date, to: Date): Array<{ key: string; label: string; startDate: string }> {
  const buckets: Array<{ key: string; label: string; startDate: string }> = [];
  const cur = new Date(from);
  cur.setUTCMinutes(0, 0, 0);
  const end = new Date(to);
  while (cur <= end) {
    const key = cur.toISOString().slice(0, 13).replace('T', ' ');
    buckets.push({
      key,
      label: `${String(cur.getUTCHours()).padStart(2, '0')}:00`,
      startDate: cur.toISOString(),
    });
    cur.setUTCHours(cur.getUTCHours() + 1);
  }
  return buckets;
}

export async function usersSignupSeriesPayload(
  granularityInput: unknown,
  fromInput?: string,
  toInput?: string
) {
  const granularity = parseUserSignupGranularity(granularityInput);
  const to = toInput ? new Date(toInput) : new Date();
  let from: Date;
  if (fromInput) {
    from = new Date(fromInput);
  } else if (granularity === 'hourly') {
    from = new Date(to.getTime() - 48 * 60 * 60 * 1000);
  } else {
    from = utcStartOfDay(to);
    from.setUTCDate(from.getUTCDate() - 29);
  }

  const bucketGroupId =
    granularity === 'hourly'
      ? { $dateToString: { format: '%Y-%m-%d %H:00', date: '$createdAt', timezone: 'UTC' } }
      : { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } };

  const agg = await User.aggregate<{ _id: string; signups: number }>([
    { $match: { role: 'user', createdAt: { $gte: from, $lte: to } } },
    { $group: { _id: bucketGroupId, signups: { $sum: 1 } } },
  ]);

  const statsByBucket = new Map<string, number>();
  for (const row of agg) {
    statsByBucket.set(row._id, row.signups ?? 0);
  }

  const bucketDefs =
    granularity === 'hourly'
      ? iterUtcHourBuckets(from, to)
      : iterUtcDateStrings(from, to).map((date) => ({ key: date, label: date, startDate: date }));

  const points = bucketDefs.map(({ key, label, startDate }) => ({
    label,
    startDate,
    signups: statsByBucket.get(key) ?? 0,
  }));

  return {
    granularity,
    from: from.toISOString(),
    to: to.toISOString(),
    points,
    note:
      granularity === 'hourly'
        ? 'New end-user signups (role=user) per UTC hour — proxy for app downloads/installs.'
        : 'New end-user signups (role=user) per UTC day.',
    generatedAt: new Date().toISOString(),
  };
}

const PAID_MOMENT_SOURCES = ['coin_purchase', 'vip_discounted'] as const;

export async function momentsPaidUsersPayload(page: number, limit: number) {
  const lim = Math.min(100, Math.max(1, limit));
  const skip = (page - 1) * lim;
  const now = new Date();
  const todayStart = utcStartOfDay(now);
  const d7 = new Date(now.getTime() - 7 * 86400000);
  const d30 = new Date(now.getTime() - 30 * 86400000);

  const matchPaid = {
    purchaseSource: { $in: PAID_MOMENT_SOURCES },
    refundedAt: null,
  };

  const [summaryAgg, rows, totalAgg] = await Promise.all([
    MomentPurchase.aggregate<{
      buyersToday: number;
      buyers7d: number;
      buyers30d: number;
      revenueCoins: number;
    }>([
      { $match: matchPaid },
      {
        $group: {
          _id: null,
          buyersToday: {
            $sum: {
              $cond: [{ $gte: ['$purchasedAt', todayStart] }, 1, 0],
            },
          },
          buyers7d: {
            $sum: { $cond: [{ $gte: ['$purchasedAt', d7] }, 1, 0] },
          },
          buyers30d: {
            $sum: { $cond: [{ $gte: ['$purchasedAt', d30] }, 1, 0] },
          },
          revenueCoins: { $sum: '$amountCoins' },
        },
      },
    ]),
    MomentPurchase.aggregate<{
      _id: mongoose.Types.ObjectId;
      purchaseCount: number;
      totalCoins: number;
      firstPurchase: Date;
      lastPurchase: Date;
    }>([
      { $match: matchPaid },
      {
        $group: {
          _id: '$userId',
          purchaseCount: { $sum: 1 },
          totalCoins: { $sum: '$amountCoins' },
          firstPurchase: { $min: '$purchasedAt' },
          lastPurchase: { $max: '$purchasedAt' },
        },
      },
      { $sort: { totalCoins: -1 } },
      { $skip: skip },
      { $limit: lim },
    ]),
    MomentPurchase.aggregate<{ _id: null; total: number }>([
      { $match: matchPaid },
      { $group: { _id: '$userId' } },
      { $count: 'total' },
    ]),
  ]);

  const userIds = rows.map((r) => r._id);
  const users =
    userIds.length > 0
      ? await User.find({ _id: { $in: userIds } })
          .select('username email phone')
          .lean()
      : [];
  const userById = new Map(users.map((u) => [u._id.toString(), u]));
  const summary = summaryAgg[0];

  return {
    summary: {
      uniqueBuyersToday: summary?.buyersToday ?? 0,
      uniqueBuyers7d: summary?.buyers7d ?? 0,
      uniqueBuyers30d: summary?.buyers30d ?? 0,
      totalRevenueCoins: summary?.revenueCoins ?? 0,
    },
    rows: rows.map((r, i) => {
      const u = userById.get(r._id.toString());
      return {
        rank: skip + i + 1,
        userId: r._id.toString(),
        username: u?.username || u?.email || u?.phone || 'Unknown',
        purchaseCount: r.purchaseCount,
        totalCoinsSpent: r.totalCoins,
        firstPurchaseAt: r.firstPurchase,
        lastPurchaseAt: r.lastPurchase,
      };
    }),
    pagination: {
      page,
      limit: lim,
      total: totalAgg[0]?.total ?? 0,
      totalPages: Math.ceil((totalAgg[0]?.total ?? 0) / lim),
    },
  };
}

function effectiveMomentsPremiumStatus(
  membership: { status: string; expiresAt: Date },
  now: Date,
): 'active' | 'expired' | 'cancelled' {
  if (membership.status === 'cancelled') return 'cancelled';
  if (membership.status === 'active' && membership.expiresAt.getTime() > now.getTime()) {
    return 'active';
  }
  return 'expired';
}

function computeMomentsPremiumDaysRemaining(expiresAt: Date, now: Date): number {
  return Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
}

export async function momentsPremiumUsersPayload(page: number, limit: number) {
  const lim = Math.min(100, Math.max(1, limit));
  const skip = (page - 1) * lim;
  const now = new Date();
  const todayStart = utcStartOfDay(now);
  const d7 = new Date(now.getTime() - 7 * 86400000);
  const d30 = new Date(now.getTime() - 30 * 86400000);

  const [activeCount, newToday, new7d, new30d, total, members] = await Promise.all([
    MomentsPremiumMembership.countDocuments({ status: 'active', expiresAt: { $gt: now } }),
    MomentsPremiumMembership.countDocuments({ startedAt: { $gte: todayStart } }),
    MomentsPremiumMembership.countDocuments({ startedAt: { $gte: d7 } }),
    MomentsPremiumMembership.countDocuments({ startedAt: { $gte: d30 } }),
    MomentsPremiumMembership.countDocuments({}),
    MomentsPremiumMembership.find({})
      .sort({ startedAt: -1 })
      .skip(skip)
      .limit(lim)
      .lean(),
  ]);

  const userIds = members.map((m) => m.userId);
  const [users, premiumTxns, revenueTxns] = await Promise.all([
    userIds.length > 0
      ? User.find({ _id: { $in: userIds } }).select('username email phone').lean()
      : [],
    CoinTransaction.find({
      userId: { $in: userIds },
      source: 'moments_premium_membership',
      status: 'completed',
    })
      .select('userId priceInr description createdAt')
      .sort({ createdAt: -1 })
      .lean(),
    CoinTransaction.find({
      source: 'moments_premium_membership',
      status: 'completed',
      createdAt: { $gte: d30 },
    })
      .select('priceInr description')
      .lean(),
  ]);

  const userById = new Map(users.map((u) => [u._id.toString(), u]));
  const txnByUser = new Map<string, { priceInr: number; paidAt: Date }>();
  for (const tx of premiumTxns) {
    const uid = tx.userId.toString();
    if (!txnByUser.has(uid)) {
      txnByUser.set(uid, {
        priceInr: tx.priceInr ?? parseInrFromPurchaseDescription(tx.description),
        paidAt: tx.createdAt,
      });
    }
  }

  const revenueInr30d = revenueTxns.reduce(
    (sum, tx) => sum + (tx.priceInr ?? parseInrFromPurchaseDescription(tx.description)),
    0,
  );

  return {
    summary: {
      activeMembers: activeCount,
      newPurchasesToday: newToday,
      newPurchases7d: new7d,
      newPurchases30d: new30d,
      revenueInr30d,
    },
    rows: members.map((m, i) => {
      const u = userById.get(m.userId.toString());
      const txn = txnByUser.get(m.userId.toString());
      const status = effectiveMomentsPremiumStatus(m, now);
      const daysRemaining =
        status === 'active' ? computeMomentsPremiumDaysRemaining(m.expiresAt, now) : 0;
      return {
        rank: skip + i + 1,
        userId: m.userId.toString(),
        username: u?.username || u?.email || u?.phone || 'Unknown',
        status,
        planId: m.planId,
        daysRemaining,
        startedAt: m.startedAt,
        expiresAt: m.expiresAt,
        priceInr: txn?.priceInr ?? 0,
        paidAt: txn?.paidAt ?? m.startedAt,
      };
    }),
    pagination: { page, limit: lim, total, totalPages: Math.ceil(total / lim) },
  };
}

export async function vipPaidUsersPayload(
  page: number,
  limit: number,
  statusFilter: 'active' | 'expired' | 'all' = 'all',
) {
  const lim = Math.min(100, Math.max(1, limit));
  const skip = (page - 1) * lim;
  const now = new Date();
  const todayStart = utcStartOfDay(now);
  const d7 = new Date(now.getTime() - 7 * 86400000);
  const d30 = new Date(now.getTime() - 30 * 86400000);

  const membershipQuery: Record<string, unknown> = {};
  if (statusFilter === 'active') {
    membershipQuery.status = 'active';
    membershipQuery.expiresAt = { $gt: now };
  } else if (statusFilter === 'expired') {
    membershipQuery.$or = [
      { status: { $in: ['expired', 'cancelled'] } },
      { status: 'active', expiresAt: { $lte: now } },
    ];
  }

  const [activeCount, newToday, new7d, new30d, total, members] = await Promise.all([
    VipMembership.countDocuments({ status: 'active', expiresAt: { $gt: now } }),
    VipMembership.countDocuments({ startedAt: { $gte: todayStart } }),
    VipMembership.countDocuments({ startedAt: { $gte: d7 } }),
    VipMembership.countDocuments({ startedAt: { $gte: d30 } }),
    VipMembership.countDocuments(membershipQuery),
    VipMembership.find(membershipQuery)
      .sort({ startedAt: -1 })
      .skip(skip)
      .limit(lim)
      .lean(),
  ]);

  const userIds = members.map((m) => m.userId);
  const [users, vipTxns] = await Promise.all([
    userIds.length > 0
      ? User.find({ _id: { $in: userIds } }).select('username email phone').lean()
      : [],
    CoinTransaction.find({
      userId: { $in: userIds },
      source: 'vip_membership',
      type: 'debit',
      status: 'completed',
    })
      .select('userId coins createdAt description')
      .lean(),
  ]);
  const userById = new Map(users.map((u) => [u._id.toString(), u]));
  const txnByUser = new Map<string, { coins: number; paidAt: Date }>();
  for (const tx of vipTxns) {
    const uid = tx.userId.toString();
    if (!txnByUser.has(uid)) {
      txnByUser.set(uid, { coins: tx.coins, paidAt: tx.createdAt });
    }
  }

  const vipRevenueAgg = await CoinTransaction.aggregate<{ _id: null; total: number }>([
    {
      $match: {
        source: 'vip_membership',
        type: 'debit',
        status: 'completed',
        createdAt: { $gte: d30 },
      },
    },
    { $group: { _id: null, total: { $sum: '$coins' } } },
  ]);

  return {
    summary: {
      activeMembers: activeCount,
      newPurchasesToday: newToday,
      newPurchases7d: new7d,
      newPurchases30d: new30d,
      revenueCoins30d: vipRevenueAgg[0]?.total ?? 0,
    },
    rows: members.map((m, i) => {
      const u = userById.get(m.userId.toString());
      const txn = txnByUser.get(m.userId.toString());
      const isActive = m.status === 'active' && m.expiresAt.getTime() > now.getTime();
      const daysRemaining = isActive
        ? Math.max(0, Math.ceil((m.expiresAt.getTime() - now.getTime()) / 86400000))
        : 0;
      return {
        rank: skip + i + 1,
        userId: m.userId.toString(),
        username: u?.username || u?.email || 'Unknown',
        status: isActive ? 'active' : 'expired',
        planId: m.planId,
        daysRemaining,
        startedAt: m.startedAt,
        expiresAt: m.expiresAt,
        coinsPaid: txn?.coins ?? 0,
        paidAt: txn?.paidAt ?? m.startedAt,
      };
    }),
    pagination: { page, limit: lim, total, totalPages: Math.ceil(total / lim) },
  };
}

export async function coinRechargePaidUsersPayload(page: number, limit: number) {
  const lim = Math.min(100, Math.max(1, limit));
  const skip = (page - 1) * lim;
  const now = new Date();
  const todayStart = utcStartOfDay(now);
  const d7 = new Date(now.getTime() - 7 * 86400000);
  const d30 = new Date(now.getTime() - 30 * 86400000);
  const rechargeMatch = {
    type: 'credit' as const,
    source: 'payment_gateway' as const,
    status: 'completed' as const,
  };

  const [summaryAgg, buyerRows, totalAgg] = await Promise.all([
    CoinTransaction.aggregate<{
      buyersToday: number;
      buyers7d: number;
      buyers30d: number;
      revenueInr30d: number;
    }>([
      { $match: rechargeMatch },
      {
        $group: {
          _id: '$userId',
          firstAt: { $min: '$createdAt' },
          lastAt: { $max: '$createdAt' },
          purchaseCount: { $sum: 1 },
          totalCoins: { $sum: '$coins' },
          totalInr: {
            $sum: {
              $cond: [
                { $gt: ['$priceInr', 0] },
                '$priceInr',
                0,
              ],
            },
          },
          descriptions: { $push: '$description' },
        },
      },
      {
        $project: {
          firstAt: 1,
          lastAt: 1,
          purchaseCount: 1,
          totalCoins: 1,
          totalInr: 1,
          descriptions: 1,
        },
      },
      {
        $group: {
          _id: null,
          buyersToday: {
            $sum: { $cond: [{ $gte: ['$firstAt', todayStart] }, 1, 0] },
          },
          buyers7d: {
            $sum: { $cond: [{ $gte: ['$firstAt', d7] }, 1, 0] },
          },
          buyers30d: {
            $sum: { $cond: [{ $gte: ['$firstAt', d30] }, 1, 0] },
          },
          revenueInr30d: {
            $sum: {
              $cond: [{ $gte: ['$lastAt', d30] }, '$totalInr', 0],
            },
          },
        },
      },
    ]),
    CoinTransaction.aggregate<{
      _id: mongoose.Types.ObjectId;
      purchaseCount: number;
      totalCoins: number;
      totalInrFromField: number;
      descriptions: string[];
      lastPurchaseAt: Date;
    }>([
      { $match: rechargeMatch },
      {
        $group: {
          _id: '$userId',
          purchaseCount: { $sum: 1 },
          totalCoins: { $sum: '$coins' },
          totalInrFromField: {
            $sum: {
              $cond: [{ $gt: ['$priceInr', 0] }, '$priceInr', 0],
            },
          },
          descriptions: { $push: '$description' },
          lastPurchaseAt: { $max: '$createdAt' },
        },
      },
      { $sort: { lastPurchaseAt: -1 } },
      { $skip: skip },
      { $limit: lim },
    ]),
    CoinTransaction.aggregate<{ _id: null; total: number }>([
      { $match: rechargeMatch },
      { $group: { _id: '$userId' } },
      { $count: 'total' },
    ]),
  ]);

  const userIds = buyerRows.map((r) => r._id);
  const users =
    userIds.length > 0
      ? await User.find({ _id: { $in: userIds } }).select('username email phone').lean()
      : [];
  const userById = new Map(users.map((u) => [u._id.toString(), u]));

  const summaryRow = summaryAgg[0];
  const uniqueBuyers = totalAgg[0]?.total ?? 0;

  return {
    summary: {
      uniqueBuyersAllTime: uniqueBuyers,
      buyersToday: summaryRow?.buyersToday ?? 0,
      buyers7d: summaryRow?.buyers7d ?? 0,
      buyers30d: summaryRow?.buyers30d ?? 0,
      revenueInr30d: summaryRow?.revenueInr30d ?? 0,
    },
    rows: buyerRows.map((r, i) => {
      const u = userById.get(r._id.toString());
      let totalInr = r.totalInrFromField ?? 0;
      if (totalInr <= 0) {
        for (const desc of r.descriptions ?? []) {
          totalInr += parseInrFromPurchaseDescription(desc);
        }
      }
      return {
        rank: skip + i + 1,
        userId: r._id.toString(),
        username: u?.username || u?.email || u?.phone || 'Unknown',
        email: u?.email ?? null,
        phone: u?.phone ?? null,
        purchaseCount: r.purchaseCount,
        totalRechargeCoins: r.totalCoins,
        totalRechargeInr: totalInr,
        lastPurchaseAt: r.lastPurchaseAt,
      };
    }),
    pagination: {
      page,
      limit: lim,
      total: uniqueBuyers,
      totalPages: Math.ceil(uniqueBuyers / lim),
    },
  };
}

export async function walletTransactionsPayload(
  page: number,
  limit: number,
  source?: string,
  from?: Date,
  to?: Date
) {
  const lim = Math.min(100, Math.max(1, limit));
  const skip = (page - 1) * lim;
  const filter: Record<string, unknown> = {};
  if (source) filter.source = source;
  if (from && to) filter.createdAt = { $gte: from, $lt: to };

  const [rows, total] = await Promise.all([
    CoinTransaction.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(lim)
      .populate('userId', 'username email role')
      .lean(),
    CoinTransaction.countDocuments(filter),
  ]);

  return {
    transactions: rows.map((tx) => ({
      id: tx._id.toString(),
      transactionId: tx.transactionId,
      userId: tx.userId?._id?.toString?.() ?? String(tx.userId),
      username:
        (tx.userId as { username?: string; email?: string })?.username ||
        (tx.userId as { email?: string })?.email ||
        'Unknown',
      type: tx.type,
      coins: tx.coins,
      source: tx.source,
      status: tx.status,
      description: tx.description,
      callId: tx.callId,
      createdAt: tx.createdAt,
    })),
    pagination: { page, limit: lim, total, totalPages: Math.ceil(total / lim) },
  };
}

export async function financePayoutsSummaryPayload(period: AnalyticsPeriod) {
  const { from, to } = periodToRange(period);
  const dateMatch = { processedAt: { $gte: from, $lte: to }, status: 'paid' as const };

  const paid = await Withdrawal.find(dateMatch).select('amount staffUserId creatorUserId').lean();
  const staffIds = [
    ...new Set(
      paid.map((w) => w.staffUserId?.toString()).filter((id): id is string => !!id)
    ),
  ].map((id) => new mongoose.Types.ObjectId(id));

  const staffUsers =
    staffIds.length > 0
      ? await User.find({ _id: { $in: staffIds } }).select('_id role').lean()
      : [];
  const roleById = new Map(staffUsers.map((u) => [u._id.toString(), u.role]));

  let hostPayouts = 0;
  let bdPayouts = 0;
  let agencyPayouts = 0;

  for (const w of paid) {
    if (w.staffUserId) {
      const role = roleById.get(w.staffUserId.toString());
      if (isBdRole(role)) bdPayouts += w.amount;
      else if (isAgencyRole(role)) agencyPayouts += w.amount;
    } else if (w.creatorUserId) {
      hostPayouts += w.amount;
    }
  }

  return {
    period,
    from: from.toISOString(),
    to: to.toISOString(),
    hostPayoutsCoins: hostPayouts,
    bdPayoutsCoins: bdPayouts,
    agencyPayoutsCoins: agencyPayouts,
    totalPayoutsCoins: hostPayouts + bdPayouts + agencyPayouts,
    paidWithdrawalCount: paid.length,
  };
}

export async function financeSettlementsPayload(page: number, limit: number) {
  const lim = Math.min(100, Math.max(1, limit));
  const skip = (page - 1) * lim;
  const filter = { status: 'paid' as const };

  const [rows, total] = await Promise.all([
    Withdrawal.find(filter)
      .sort({ processedAt: -1 })
      .skip(skip)
      .limit(lim)
      .lean(),
    Withdrawal.countDocuments(filter),
  ]);

  const txnIds = rows.map((r) => r.transactionId).filter((id): id is string => !!id);
  const txns =
    txnIds.length > 0
      ? await CoinTransaction.find({ transactionId: { $in: txnIds } }).lean()
      : [];
  const txnById = new Map(txns.map((t) => [t.transactionId, t]));

  return {
    settlements: rows.map((w) => ({
      withdrawalId: w._id.toString(),
      amount: w.amount,
      status: w.status,
      processedAt: w.processedAt,
      staffUserId: w.staffUserId?.toString() ?? null,
      creatorUserId: w.creatorUserId?.toString() ?? null,
      transactionId: w.transactionId ?? null,
      ledgerCoins: w.transactionId ? txnById.get(w.transactionId)?.coins ?? null : null,
    })),
    pagination: { page, limit: lim, total, totalPages: Math.ceil(total / lim) },
  };
}

export async function revenueSummaryPayload(period: AnalyticsPeriod) {
  const { from, to } = periodToRange(period);
  const createdAt = { $gte: from, $lte: to };

  const independentCreatorIds = await Creator.find({ assignedAgencyId: null })
    .select('userId')
    .lean();
  const independentUserIds = independentCreatorIds
    .map((c) => c.userId)
    .filter((id): id is mongoose.Types.ObjectId => Boolean(id));

  const staffedCreatorIds = await Creator.find({ assignedAgencyId: { $ne: null } })
    .select('userId')
    .lean();
  const staffedUserIds = staffedCreatorIds
    .map((c) => c.userId)
    .filter((id): id is mongoose.Types.ObjectId => Boolean(id));

  const [
    grossAgg,
    hostAgg,
    independentHostAgg,
    staffedHostAgg,
    staffLedgerRows,
    momentsAgg,
    vipAgg,
    payouts,
  ] = await Promise.all([
    CallHistory.aggregate<{ _id: null; total: number }>([
      { $match: { ownerRole: 'user', createdAt } },
      { $group: { _id: null, total: { $sum: '$coinsDeducted' } } },
    ]),
    CallHistory.aggregate<{ _id: null; total: number }>([
      { $match: { ownerRole: 'creator', createdAt } },
      { $group: { _id: null, total: { $sum: '$coinsEarned' } } },
    ]),
    independentUserIds.length > 0
      ? CallHistory.aggregate<{ _id: null; total: number }>([
          {
            $match: {
              ownerRole: 'creator',
              ownerUserId: { $in: independentUserIds },
              createdAt,
            },
          },
          { $group: { _id: null, total: { $sum: '$coinsEarned' } } },
        ])
      : Promise.resolve([]),
    staffedUserIds.length > 0
      ? CallHistory.aggregate<{ _id: null; total: number }>([
          {
            $match: {
              ownerRole: 'creator',
              ownerUserId: { $in: staffedUserIds },
              createdAt,
            },
          },
          { $group: { _id: null, total: { $sum: '$coinsEarned' } } },
        ])
      : Promise.resolve([]),
    StaffWalletLedger.aggregate<{ _id: mongoose.Types.ObjectId; total: number }>([
      {
        $match: {
          direction: 'credit',
          sourceType: 'call_settlement',
          createdAt,
        },
      },
      { $group: { _id: '$staffUserId', total: { $sum: '$amountCoins' } } },
    ]),
    MomentPurchase.aggregate<{ _id: null; total: number }>([
      {
        $match: {
          purchaseSource: { $in: PAID_MOMENT_SOURCES },
          refundedAt: null,
          purchasedAt: createdAt,
        },
      },
      { $group: { _id: null, total: { $sum: '$amountCoins' } } },
    ]),
    CoinTransaction.aggregate<{ _id: null; total: number }>([
      {
        $match: {
          source: 'vip_membership',
          type: 'debit',
          status: 'completed',
          createdAt,
        },
      },
      { $group: { _id: null, total: { $sum: '$coins' } } },
    ]),
    financePayoutsSummaryPayload(period),
  ]);

  const grossCallRevenue = grossAgg[0]?.total ?? 0;
  const hostRevenue = hostAgg[0]?.total ?? 0;
  const independentHostRevenue = independentHostAgg[0]?.total ?? 0;
  const staffedHostRevenue = staffedHostAgg[0]?.total ?? 0;

  let bdRevenue = 0;
  let agencyRevenue = 0;
  if (staffLedgerRows.length > 0) {
    const staffIds = staffLedgerRows.map((r) => r._id);
    const staffUsers = await User.find({ _id: { $in: staffIds } }).select('_id role').lean();
    const roleById = new Map(staffUsers.map((u) => [u._id.toString(), u.role]));
    for (const row of staffLedgerRows) {
      const role = roleById.get(row._id.toString());
      if (isBdRole(role)) bdRevenue += row.total;
      else if (isAgencyRole(role)) agencyRevenue += row.total;
    }
  }

  const platformRevenue = Math.max(
    0,
    grossCallRevenue - hostRevenue - bdRevenue - agencyRevenue
  );

  return {
    period,
    from: from.toISOString(),
    to: to.toISOString(),
    calls: {
      grossRevenueCoins: grossCallRevenue,
      hostRevenueCoins: hostRevenue,
      independentHostRevenueCoins: independentHostRevenue,
      staffedHostRevenueCoins: staffedHostRevenue,
      bdRevenueCoins: bdRevenue,
      agencyRevenueCoins: agencyRevenue,
      platformRevenueCoins: platformRevenue,
    },
    moments: {
      revenueCoins: momentsAgg[0]?.total ?? 0,
    },
    vip: {
      revenueCoins: vipAgg[0]?.total ?? 0,
    },
    payouts,
    generatedAt: new Date().toISOString(),
  };
}

const LEADERBOARD_CACHE_TTL = 1800;

export async function cachedLeaderboardHosts<T>(
  cacheKey: string,
  compute: () => Promise<T>
): Promise<T> {
  const redis = getRedis();
  const key = `admin:leaderboard:hosts:${cacheKey}`;
  try {
    const cached = await redis.get(key);
    if (cached) {
      return (typeof cached === 'string' ? JSON.parse(cached) : cached) as T;
    }
  } catch {
    /* compute fresh */
  }
  const result = await compute();
  try {
    await redis.setex(key, LEADERBOARD_CACHE_TTL, JSON.stringify(result));
  } catch {
    /* ignore */
  }
  return result;
}
