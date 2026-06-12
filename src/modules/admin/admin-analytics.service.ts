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
import { isBdRole, isAgencyRole } from '../../utils/staff-roles';
import { getRedis } from '../../config/redis';

export type AnalyticsPeriod = 'today' | '7d' | '30d';

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

export async function vipPaidUsersPayload(page: number, limit: number) {
  const lim = Math.min(100, Math.max(1, limit));
  const skip = (page - 1) * lim;
  const now = new Date();
  const todayStart = utcStartOfDay(now);
  const d7 = new Date(now.getTime() - 7 * 86400000);
  const d30 = new Date(now.getTime() - 30 * 86400000);

  const [activeCount, newToday, new7d, new30d, total, members] = await Promise.all([
    VipMembership.countDocuments({ status: 'active', expiresAt: { $gt: now } }),
    VipMembership.countDocuments({ startedAt: { $gte: todayStart } }),
    VipMembership.countDocuments({ startedAt: { $gte: d7 } }),
    VipMembership.countDocuments({ startedAt: { $gte: d30 } }),
    VipMembership.countDocuments({}),
    VipMembership.find({})
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
      return {
        rank: skip + i + 1,
        userId: m.userId.toString(),
        username: u?.username || u?.email || 'Unknown',
        status: m.status,
        planId: m.planId,
        startedAt: m.startedAt,
        expiresAt: m.expiresAt,
        coinsPaid: txn?.coins ?? 0,
        paidAt: txn?.paidAt ?? m.startedAt,
      };
    }),
    pagination: { page, limit: lim, total, totalPages: Math.ceil(total / lim) },
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
  const creatorIds = [
    ...new Set(
      paid
        .filter((w) => !w.staffUserId && w.creatorUserId)
        .map((w) => w.creatorUserId!.toString())
    ),
  ];

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
