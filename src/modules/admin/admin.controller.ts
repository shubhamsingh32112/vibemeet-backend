import type { Request } from 'express';
import { Response } from 'express';
import mongoose from 'mongoose';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { CallHistory } from '../billing/call-history.model';
import { CreatorTaskProgress } from '../creator/creator-task.model';
import {
  ChatMessageQuota,
  FREE_MESSAGES_PER_CREATOR,
} from '../chat/chat-message-quota.model';
import { CREATOR_TASKS } from '../creator/creator-tasks.config';
import {
  getRedis,
  adminCacheKey,
  ADMIN_CACHE_TTL,
  invalidateAdminCaches,
} from '../../config/redis';
import { randomUUID } from 'crypto';
import { getIO } from '../../config/socket';
import { setCreatorAvailability } from '../availability/availability.gateway';
import { AdminActionLog } from './admin-action-log.model';
import { emitCreatorDataUpdated } from '../creator/creator.controller';
import { verifyUserBalance, batchVerifyBalances } from '../../utils/balance-integrity';
import { Withdrawal } from '../creator/withdrawal.model';
import { SupportTicket } from '../support/support.model';
import {
  DEFAULT_WALLET_COIN_PACKAGES,
  IWalletCoinPack,
  getOrCreateWalletPricingConfig,
} from '../payment/wallet-pricing.model';

// ══════════════════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════════════════

/** Maximum age (in days) of a call that can still be refunded */
const REFUND_MAX_AGE_DAYS = 30;

// ══════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════

async function getAdminUser(req: Request): Promise<any | null> {
  if (!req.auth) return null;
  return User.findOne({ firebaseUid: req.auth.firebaseUid }).lean();
}

async function assertAdmin(req: Request, res: Response): Promise<boolean> {
  if (!req.auth) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  const admin = await getAdminUser(req);
  if (!admin || admin.role !== 'admin') {
    res.status(403).json({ success: false, error: 'Admin access required' });
    return false;
  }
  return true;
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Write to AdminActionLog (fire-and-forget, never blocks the response) */
async function logAdminAction(
  adminUser: any,
  action: string,
  targetType: 'user' | 'creator' | 'call' | 'withdrawal' | 'support' | 'wallet_pricing',
  targetId: string,
  reason: string,
  details: Record<string, any> = {}
): Promise<void> {
  try {
    await new AdminActionLog({
      adminUserId: adminUser._id,
      adminEmail: adminUser.email || 'unknown',
      action,
      targetType,
      targetId,
      reason,
      details,
    }).save();
  } catch (err) {
    console.error('⚠️ [ADMIN] Failed to write action log:', err);
  }
}

// ── Redis cache helpers ──────────────────────────────────────────────────

async function getCachedOrCompute<T>(
  cacheSection: string,
  computeFn: () => Promise<T>
): Promise<T> {
  const redis = getRedis();
  const key = adminCacheKey(cacheSection);
  try {
    const cached = await redis.get(key);
    if (cached) {
      return (typeof cached === 'string' ? JSON.parse(cached) : cached) as T;
    }
  } catch (err) {
    console.warn('⚠️ [REDIS] Cache read failed, computing fresh:', err);
  }

  const result = await computeFn();

  // Write-behind — don't block the response
  redis
    .set(key, JSON.stringify(result), { ex: ADMIN_CACHE_TTL })
    .catch((err: any) =>
      console.warn('⚠️ [REDIS] Cache write failed:', err)
    );

  return result;
}

// ══════════════════════════════════════════════════════════════════════════
// GET /admin/overview — Global dashboard metrics (CACHED 60s)
// ══════════════════════════════════════════════════════════════════════════
export const getOverview = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const data = await getCachedOrCompute('overview', computeOverview);

    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ [ADMIN] Overview error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

async function computeOverview() {
  const now = new Date();
  const today = daysAgo(0);
  const sevenDaysAgo = daysAgo(7);
  const thirtyDaysAgo = daysAgo(30);

  const [
    totalUsers,
    totalCreators,
    onlineCreators,
    totalAdmins,
    usersByRole,
    coinCirculation,
    coinFlowToday,
    coinFlow7d,
    coinFlow30d,
    coinsBySource,
    callStats30d,
    callStatsToday,
    totalCallsAllTime,
    chatQuotaStats,
    recentSignups7d,
    onboardedUsers,
    welcomeBonusClaimed,
    // Phase 2+3: Withdrawal & Support stats in overview
    pendingWithdrawals,
    totalWithdrawn30d,
    openSupportTickets,
    highPrioritySupportTickets,
  ] = await Promise.all([
    User.countDocuments({ role: 'user' }),
    Creator.countDocuments({}),
    Creator.countDocuments({ isOnline: true }),
    User.countDocuments({ role: 'admin' }),
    User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]),
    User.aggregate([{ $group: { _id: null, total: { $sum: '$coins' } } }]),
    CoinTransaction.aggregate([
      { $match: { createdAt: { $gte: today }, status: 'completed' } },
      { $group: { _id: '$type', total: { $sum: '$coins' }, count: { $sum: 1 } } },
    ]),
    CoinTransaction.aggregate([
      { $match: { createdAt: { $gte: sevenDaysAgo }, status: 'completed' } },
      { $group: { _id: '$type', total: { $sum: '$coins' }, count: { $sum: 1 } } },
    ]),
    CoinTransaction.aggregate([
      { $match: { createdAt: { $gte: thirtyDaysAgo }, status: 'completed' } },
      { $group: { _id: '$type', total: { $sum: '$coins' }, count: { $sum: 1 } } },
    ]),
    CoinTransaction.aggregate([
      { $match: { createdAt: { $gte: thirtyDaysAgo }, status: 'completed' } },
      { $group: { _id: { source: '$source', type: '$type' }, total: { $sum: '$coins' }, count: { $sum: 1 } } },
    ]),
    CallHistory.aggregate([
      { $match: { createdAt: { $gte: thirtyDaysAgo }, ownerRole: 'user' } },
      {
        $group: {
          _id: null,
          totalCalls: { $sum: 1 },
          totalDurationSec: { $sum: '$durationSeconds' },
          avgDurationSec: { $avg: '$durationSeconds' },
          totalCoinsSpent: { $sum: '$coinsDeducted' },
          zeroDurationCalls: { $sum: { $cond: [{ $eq: ['$durationSeconds', 0] }, 1, 0] } },
          shortCalls: { $sum: { $cond: [{ $and: [{ $gt: ['$durationSeconds', 0] }, { $lt: ['$durationSeconds', 10] }] }, 1, 0] } },
        },
      },
    ]),
    CallHistory.aggregate([
      { $match: { createdAt: { $gte: today }, ownerRole: 'user' } },
      { $group: { _id: null, totalCalls: { $sum: 1 }, totalDurationSec: { $sum: '$durationSeconds' }, totalCoinsSpent: { $sum: '$coinsDeducted' } } },
    ]),
    CallHistory.countDocuments({ ownerRole: 'user' }),
    ChatMessageQuota.aggregate([
      {
        $group: {
          _id: null,
          totalChannels: { $sum: 1 },
          totalFreeMessages: { $sum: '$freeMessagesSent' },
          totalPaidMessages: { $sum: '$paidMessagesSent' },
          exhaustedQuotas: { $sum: { $cond: [{ $gte: ['$freeMessagesSent', FREE_MESSAGES_PER_CREATOR] }, 1, 0] } },
        },
      },
    ]),
    User.countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
    User.countDocuments({ role: 'user', categories: { $exists: true, $ne: [] } }),
    User.countDocuments({ welcomeBonusClaimed: true }),
    Withdrawal.countDocuments({ status: 'pending' }),
    Withdrawal.aggregate([
      { $match: { status: { $in: ['approved', 'paid'] }, createdAt: { $gte: thirtyDaysAgo } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    SupportTicket.countDocuments({ status: { $in: ['open', 'in_progress'] } }),
    SupportTicket.countDocuments({ priority: { $in: ['high', 'urgent'] }, status: { $in: ['open', 'in_progress'] } }),
  ]);

  const parseCoinFlow = (agg: any[]) => {
    const credits = agg.find((a) => a._id === 'credit');
    const debits = agg.find((a) => a._id === 'debit');
    return {
      credited: credits?.total ?? 0,
      creditCount: credits?.count ?? 0,
      debited: debits?.total ?? 0,
      debitCount: debits?.count ?? 0,
      net: (credits?.total ?? 0) - (debits?.total ?? 0),
    };
  };

  const call30d = callStats30d[0] || { totalCalls: 0, totalDurationSec: 0, avgDurationSec: 0, totalCoinsSpent: 0, zeroDurationCalls: 0, shortCalls: 0 };
  const callToday = callStatsToday[0] || { totalCalls: 0, totalDurationSec: 0, totalCoinsSpent: 0 };
  const chat = chatQuotaStats[0] || { totalChannels: 0, totalFreeMessages: 0, totalPaidMessages: 0, exhaustedQuotas: 0 };

  const sourceBreakdown: Record<string, { credited: number; debited: number }> = {};
  for (const row of coinsBySource) {
    const src = row._id.source;
    if (!sourceBreakdown[src]) sourceBreakdown[src] = { credited: 0, debited: 0 };
    if (row._id.type === 'credit') sourceBreakdown[src].credited = row.total;
    else sourceBreakdown[src].debited = row.total;
  }

  return {
    users: {
      total: totalUsers,
      creators: totalCreators,
      admins: totalAdmins,
      onlineCreators,
      recentSignups7d,
      onboarded: onboardedUsers,
      welcomeBonusClaimed,
      byRole: usersByRole.reduce((acc: Record<string, number>, r: any) => { acc[r._id || 'unknown'] = r.count; return acc; }, {}),
    },
    coins: {
      totalInCirculation: coinCirculation[0]?.total ?? 0,
      today: parseCoinFlow(coinFlowToday),
      last7d: parseCoinFlow(coinFlow7d),
      last30d: parseCoinFlow(coinFlow30d),
      bySource30d: sourceBreakdown,
    },
    calls: {
      totalAllTime: totalCallsAllTime,
      today: callToday,
      last30d: {
        totalCalls: call30d.totalCalls,
        totalDurationMin: Math.round((call30d.totalDurationSec / 60) * 100) / 100,
        avgDurationSec: Math.round((call30d.avgDurationSec || 0) * 100) / 100,
        totalCoinsSpent: call30d.totalCoinsSpent,
        zeroDurationCalls: call30d.zeroDurationCalls,
        shortCalls: call30d.shortCalls,
        revenuePerMinute: call30d.totalDurationSec > 0
          ? Math.round((call30d.totalCoinsSpent / (call30d.totalDurationSec / 60)) * 100) / 100
          : 0,
      },
    },
    chat: {
      totalChannels: chat.totalChannels,
      totalFreeMessages: chat.totalFreeMessages,
      totalPaidMessages: chat.totalPaidMessages,
      exhaustedQuotas: chat.exhaustedQuotas,
      freeToPayConversion: chat.totalChannels > 0
        ? Math.round((chat.exhaustedQuotas / chat.totalChannels) * 10000) / 100
        : 0,
    },
    withdrawals: {
      pendingCount: pendingWithdrawals,
      totalWithdrawn30d: totalWithdrawn30d[0]?.total ?? 0,
    },
    support: {
      openTickets: openSupportTickets,
      highPriorityTickets: highPrioritySupportTickets,
    },
    generatedAt: now.toISOString(),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// GET /admin/creators/performance — Creator performance table (CACHED 60s)
// With abuse signals.
// ══════════════════════════════════════════════════════════════════════════
export const getCreatorsPerformance = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const data = await getCachedOrCompute('creators_performance', computeCreatorsPerformance);

    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ [ADMIN] Creators performance error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

async function computeCreatorsPerformance() {
  const thirtyDaysAgo = daysAgo(30);

  const creators = await Creator.find({}).lean();
  const userIds = creators.map((c) => c.userId);
  const users = await User.find({ _id: { $in: userIds } }).lean();
  const userMap = new Map(users.map((u) => [u._id.toString(), u]));

  // All-time call stats per creator
  const callStatsPerCreator = await CallHistory.aggregate([
    { $match: { ownerRole: 'creator', ownerUserId: { $in: userIds } } },
    {
      $group: {
        _id: '$ownerUserId',
        totalCalls: { $sum: 1 },
        totalDurationSec: { $sum: '$durationSeconds' },
        totalEarned: { $sum: '$coinsEarned' },
        avgDurationSec: { $avg: '$durationSeconds' },
        lastCallAt: { $max: '$createdAt' },
      },
    },
  ]);
  const callMap = new Map(callStatsPerCreator.map((c: any) => [c._id.toString(), c]));

  // 30d call stats per creator
  const callStats30d = await CallHistory.aggregate([
    { $match: { ownerRole: 'creator', ownerUserId: { $in: userIds }, createdAt: { $gte: thirtyDaysAgo } } },
    {
      $group: {
        _id: '$ownerUserId',
        calls30d: { $sum: 1 },
        minutes30d: { $sum: '$durationSeconds' },
        earned30d: { $sum: '$coinsEarned' },
      },
    },
  ]);
  const call30dMap = new Map(callStats30d.map((c: any) => [c._id.toString(), c]));

  // Task progress per creator
  const taskProgress = await CreatorTaskProgress.aggregate([
    { $match: { creatorUserId: { $in: userIds } } },
    {
      $group: {
        _id: '$creatorUserId',
        tasksCompleted: { $sum: { $cond: [{ $ne: ['$completedAt', null] }, 1, 0] } },
        tasksClaimed: { $sum: { $cond: [{ $ne: ['$claimedAt', null] }, 1, 0] } },
      },
    },
  ]);
  const taskMap = new Map(taskProgress.map((t: any) => [t._id.toString(), t]));

  // ── Abuse signals (30d) ─────────────────────────────────────────────
  // Per-creator: short call %, refund count, forced-end count (user-side 0-duration)
  const abuseSignalsAgg = await CallHistory.aggregate([
    { $match: { ownerRole: 'creator', ownerUserId: { $in: userIds }, createdAt: { $gte: thirtyDaysAgo } } },
    {
      $group: {
        _id: '$ownerUserId',
        total: { $sum: 1 },
        shortCalls: { $sum: { $cond: [{ $lt: ['$durationSeconds', 20] }, 1, 0] } },
        zeroDuration: { $sum: { $cond: [{ $eq: ['$durationSeconds', 0] }, 1, 0] } },
      },
    },
  ]);
  const abuseMap = new Map(abuseSignalsAgg.map((a: any) => [a._id.toString(), a]));

  // Refund count per creator (by matching creator-side callIds against refund transactions)
  const creatorCallIds = await CallHistory.find({
    ownerRole: 'creator',
    ownerUserId: { $in: userIds },
    createdAt: { $gte: thirtyDaysAgo },
  })
    .select('callId ownerUserId')
    .lean();

  // Group callIds by creatorUserId
  const callIdsByCreator = new Map<string, string[]>();
  for (const rec of creatorCallIds) {
    const uid = rec.ownerUserId.toString();
    if (!callIdsByCreator.has(uid)) callIdsByCreator.set(uid, []);
    callIdsByCreator.get(uid)!.push(rec.callId);
  }

  // Count refunds per creator (look for REFUND CoinTransactions with those callIds)
  const allCallIds = creatorCallIds.map((r) => r.callId);
  const refundsAgg = allCallIds.length > 0
    ? await CoinTransaction.aggregate([
        { $match: { callId: { $in: allCallIds }, source: 'admin', description: { $regex: /^REFUND/ } } },
        { $group: { _id: '$callId', count: { $sum: 1 } } },
      ])
    : [];
  const refundedCallIds = new Set(refundsAgg.map((r: any) => r._id));

  // Count refunds per creator
  const refundCountByCreator = new Map<string, number>();
  for (const [creatorUserId, callIds] of callIdsByCreator) {
    const cnt = callIds.filter((id) => refundedCallIds.has(id)).length;
    if (cnt > 0) refundCountByCreator.set(creatorUserId, cnt);
  }

  // Build performance table
  const performance = creators.map((creator) => {
    const userId = creator.userId.toString();
    const user = userMap.get(userId);
    const calls = callMap.get(userId) || { totalCalls: 0, totalDurationSec: 0, totalEarned: 0, avgDurationSec: 0, lastCallAt: null };
    const c30d = call30dMap.get(userId) || { calls30d: 0, minutes30d: 0, earned30d: 0 };
    const tasks = taskMap.get(userId) || { tasksCompleted: 0, tasksClaimed: 0 };
    const abuse = abuseMap.get(userId) || { total: 0, shortCalls: 0, zeroDuration: 0 };

    const shortCallPct = abuse.total > 0
      ? Math.round((abuse.shortCalls / abuse.total) * 10000) / 100
      : 0;
    const refundCount = refundCountByCreator.get(userId) || 0;
    const refundRate = abuse.total > 0
      ? Math.round((refundCount / abuse.total) * 10000) / 100
      : 0;
    const earningsPerMinute = calls.totalDurationSec > 0
      ? Math.round((calls.totalEarned / (calls.totalDurationSec / 60)) * 100) / 100
      : 0;
    const earnDeviation = creator.price > 0 && earningsPerMinute > 0
      ? Math.round(((earningsPerMinute - creator.price) / creator.price) * 10000) / 100
      : 0;

    // Flag if (shortCallPct > 30% AND refunds > 0) OR earnDeviation significantly off
    const isFlagged =
      (shortCallPct > 30 && refundCount > 0) ||
      (abuse.total >= 5 && shortCallPct > 50);

    return {
      creatorId: creator._id.toString(),
      userId,
      name: creator.name,
      photo: creator.photo,
      categories: creator.categories,
      price: creator.price,
      isOnline: creator.isOnline,
      email: user?.email || null,
      phone: user?.phone || null,
      coins: user?.coins ?? 0,
      createdAt: creator.createdAt,
      totalCalls: calls.totalCalls,
      totalMinutes: Math.round((calls.totalDurationSec / 60) * 100) / 100,
      totalEarned: calls.totalEarned,
      avgCallDurationSec: Math.round((calls.avgDurationSec || 0) * 100) / 100,
      lastCallAt: calls.lastCallAt,
      calls30d: c30d.calls30d,
      minutes30d: Math.round((c30d.minutes30d / 60) * 100) / 100,
      earned30d: c30d.earned30d,
      tasksTotal: CREATOR_TASKS.length,
      tasksCompleted: tasks.tasksCompleted,
      tasksClaimed: tasks.tasksClaimed,
      earningsPerMinute,
      // ── Abuse signals ──
      abuseSignals: {
        shortCallPct,
        zeroDuration30d: abuse.zeroDuration,
        refundCount,
        refundRate,
        earnDeviation,
        isFlagged,
      },
    };
  });

  performance.sort((a, b) => b.earned30d - a.earned30d);

  return { creators: performance };
}

// ══════════════════════════════════════════════════════════════════════════
// GET /admin/users/analytics — User analytics & table (CACHED 60s when no filters)
// ══════════════════════════════════════════════════════════════════════════
export const getUsersAnalytics = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const { query, role, sort } = req.query;
    const searchQuery = query as string | undefined;
    const roleFilter = role as string | undefined;
    const sortField = sort as string | undefined;

    // Only cache the unfiltered default view
    const hasFilters = (searchQuery && searchQuery.trim()) || (roleFilter && roleFilter !== 'all') || sortField;

    const data = hasFilters
      ? await computeUsersAnalytics(searchQuery, roleFilter, sortField)
      : await getCachedOrCompute('users_analytics', () =>
          computeUsersAnalytics(undefined, undefined, undefined)
        );

    res.json({ success: true, data: { users: data } });
  } catch (error) {
    console.error('❌ [ADMIN] Users analytics error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

async function computeUsersAnalytics(
  searchQuery?: string,
  roleFilter?: string,
  sortField?: string
) {
  const filter: any = {};
  if (roleFilter && roleFilter !== 'all') filter.role = roleFilter;
  if (searchQuery && searchQuery.trim()) {
    const regex = new RegExp(searchQuery.trim(), 'i');
    filter.$or = [{ username: regex }, { email: regex }, { phone: regex }];
  }

  const users = await User.find(filter)
    .select('firebaseUid email phone gender username avatar categories coins welcomeBonusClaimed role usernameChangeCount createdAt')
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  const userIds = users.map((u) => u._id);

  const [spendingAgg, creditAgg, callAgg, chatAgg, creatorExistence] = await Promise.all([
    CoinTransaction.aggregate([
      { $match: { userId: { $in: userIds }, type: 'debit', status: 'completed' } },
      { $group: { _id: '$userId', totalSpent: { $sum: '$coins' }, txCount: { $sum: 1 } } },
    ]),
    CoinTransaction.aggregate([
      { $match: { userId: { $in: userIds }, type: 'credit', status: 'completed' } },
      { $group: { _id: '$userId', totalCredited: { $sum: '$coins' } } },
    ]),
    CallHistory.aggregate([
      { $match: { ownerUserId: { $in: userIds }, ownerRole: 'user' } },
      { $group: { _id: '$ownerUserId', callCount: { $sum: 1 }, totalMinutes: { $sum: '$durationSeconds' } } },
    ]),
    ChatMessageQuota.aggregate([
      { $match: { userFirebaseUid: { $in: users.map((u) => u.firebaseUid) } } },
      { $group: { _id: '$userFirebaseUid', chatChannels: { $sum: 1 }, totalFreeMessages: { $sum: '$freeMessagesSent' }, totalPaidMessages: { $sum: '$paidMessagesSent' } } },
    ]),
    Creator.find({ userId: { $in: userIds } }).select('userId').lean(),
  ]);

  const spendMap = new Map(spendingAgg.map((s: any) => [s._id.toString(), s]));
  const creditMap = new Map(creditAgg.map((c: any) => [c._id.toString(), c]));
  const callMap = new Map(callAgg.map((c: any) => [c._id.toString(), c]));
  const chatMap = new Map(chatAgg.map((c: any) => [c._id, c]));
  const creatorUserIds = new Set(creatorExistence.map((c) => c.userId.toString()));

  const userList = users.map((user) => {
    const uid = user._id.toString();
    const spend = spendMap.get(uid) || { totalSpent: 0, txCount: 0 };
    const credit = creditMap.get(uid) || { totalCredited: 0 };
    const calls = callMap.get(uid) || { callCount: 0, totalMinutes: 0 };
    const chat = chatMap.get(user.firebaseUid) || { chatChannels: 0, totalFreeMessages: 0, totalPaidMessages: 0 };

    return {
      id: uid,
      firebaseUid: user.firebaseUid,
      email: user.email,
      phone: user.phone,
      username: user.username,
      avatar: user.avatar,
      gender: user.gender,
      role: user.role,
      coins: user.coins,
      welcomeBonusClaimed: user.welcomeBonusClaimed,
      categories: user.categories,
      isCreator: creatorUserIds.has(uid),
      createdAt: user.createdAt,
      totalSpent: spend.totalSpent,
      totalCredited: credit.totalCredited,
      transactionCount: spend.txCount,
      callCount: calls.callCount,
      totalCallMinutes: Math.round((calls.totalMinutes / 60) * 100) / 100,
      chatChannels: chat.chatChannels,
      freeMessages: chat.totalFreeMessages,
      paidMessages: chat.totalPaidMessages,
    };
  });

  if (sortField === 'spent') userList.sort((a, b) => b.totalSpent - a.totalSpent);
  else if (sortField === 'calls') userList.sort((a, b) => b.callCount - a.callCount);
  else if (sortField === 'coins') userList.sort((a, b) => b.coins - a.coins);

  return userList;
}

// ══════════════════════════════════════════════════════════════════════════
// GET /admin/users/:id/ledger — Full coin ledger for a single user
// (Not cached — drill-down should always be live)
// ══════════════════════════════════════════════════════════════════════════
export const getUserLedger = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, error: 'Invalid user ID' });
      return;
    }

    const user = await User.findById(id).lean();
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const [transactions, calls, creator, chatQuotas] = await Promise.all([
      CoinTransaction.find({ userId: user._id }).sort({ createdAt: -1 }).limit(500).lean(),
      CallHistory.find({ ownerUserId: user._id }).sort({ createdAt: -1 }).limit(100).lean(),
      Creator.findOne({ userId: user._id }).lean(),
      ChatMessageQuota.find({ userFirebaseUid: user.firebaseUid }).lean(),
    ]);

    const credits = transactions.filter((t) => t.type === 'credit' && t.status === 'completed').reduce((sum, t) => sum + t.coins, 0);
    const debits = transactions.filter((t) => t.type === 'debit' && t.status === 'completed').reduce((sum, t) => sum + t.coins, 0);

    res.json({
      success: true,
      data: {
        user: {
          id: user._id.toString(),
          firebaseUid: user.firebaseUid,
          email: user.email,
          phone: user.phone,
          username: user.username,
          avatar: user.avatar,
          gender: user.gender,
          role: user.role,
          coins: user.coins,
          welcomeBonusClaimed: user.welcomeBonusClaimed,
          categories: user.categories,
          usernameChangeCount: user.usernameChangeCount,
          createdAt: user.createdAt,
        },
        creator: creator
          ? { id: creator._id.toString(), name: creator.name, price: creator.price, isOnline: creator.isOnline, categories: creator.categories }
          : null,
        transactions: transactions.map((t) => ({
          id: t._id.toString(),
          transactionId: t.transactionId,
          type: t.type,
          coins: t.coins,
          source: t.source,
          description: t.description,
          callId: t.callId,
          status: t.status,
          createdAt: t.createdAt,
        })),
        calls: calls.map((c) => ({
          callId: c.callId,
          otherName: c.otherName,
          otherAvatar: c.otherAvatar,
          ownerRole: c.ownerRole,
          durationSeconds: c.durationSeconds,
          coinsDeducted: c.coinsDeducted,
          coinsEarned: c.coinsEarned,
          createdAt: c.createdAt,
        })),
        chatQuotas: chatQuotas.map((q) => ({
          channelId: q.channelId,
          creatorFirebaseUid: q.creatorFirebaseUid,
          freeMessagesSent: q.freeMessagesSent,
          paidMessagesSent: q.paidMessagesSent,
        })),
        summary: {
          totalCredited: credits,
          totalDebited: debits,
          expectedBalance: credits - debits,
          actualBalance: user.coins,
          discrepancy: user.coins - (credits - debits),
        },
      },
    });
  } catch (error) {
    console.error('❌ [ADMIN] User ledger error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// GET /admin/coins — Coin economy deep dive (CACHED 60s)
// ══════════════════════════════════════════════════════════════════════════
export const getCoinEconomy = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const data = await getCachedOrCompute('coins', computeCoinEconomy);

    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ [ADMIN] Coin economy error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// GET /admin/wallet-pricing — Wallet package tier pricing config (live)
// ══════════════════════════════════════════════════════════════════════════
export const getWalletPricing = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const config = await getOrCreateWalletPricingConfig();
    const packages = [...config.packages].sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.coins - b.coins;
    });

    res.json({
      success: true,
      data: {
        packages,
        defaults: DEFAULT_WALLET_COIN_PACKAGES,
        updatedAt: config.updatedAt.toISOString(),
        updatedByAdminId: config.updatedByAdminId?.toString() || null,
      },
    });
  } catch (error) {
    console.error('❌ [ADMIN] Get wallet pricing error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

function normalizeWalletPackages(input: unknown): IWalletCoinPack[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('packages must be a non-empty array');
  }

  const seenCoins = new Set<number>();
  return input.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`packages[${index}] must be an object`);
    }

    const row = item as Record<string, unknown>;
    const coins = Number(row.coins);
    const tier1PriceInr = Number(row.tier1PriceInr);
    const tier2PriceInr = Number(row.tier2PriceInr);
    const oldPriceInrRaw = row.oldPriceInr;
    const oldPriceInr =
      oldPriceInrRaw === null || oldPriceInrRaw === undefined || oldPriceInrRaw === ''
        ? undefined
        : Number(oldPriceInrRaw);
    const badgeRaw = row.badge;
    const badge =
      typeof badgeRaw === 'string' && badgeRaw.trim().length > 0
        ? badgeRaw.trim()
        : undefined;
    const isActive = row.isActive !== false;
    const sortOrderRaw = row.sortOrder;
    const sortOrder =
      sortOrderRaw === null || sortOrderRaw === undefined || sortOrderRaw === ''
        ? index + 1
        : Number(sortOrderRaw);

    if (!Number.isInteger(coins) || coins <= 0) {
      throw new Error(`packages[${index}].coins must be a positive integer`);
    }
    if (seenCoins.has(coins)) {
      throw new Error(`Duplicate coin pack found for ${coins} coins`);
    }
    seenCoins.add(coins);

    if (!Number.isFinite(tier1PriceInr) || tier1PriceInr <= 0) {
      throw new Error(`packages[${index}].tier1PriceInr must be > 0`);
    }
    if (!Number.isFinite(tier2PriceInr) || tier2PriceInr <= 0) {
      throw new Error(`packages[${index}].tier2PriceInr must be > 0`);
    }
    if (oldPriceInr !== undefined && (!Number.isFinite(oldPriceInr) || oldPriceInr <= 0)) {
      throw new Error(`packages[${index}].oldPriceInr must be > 0 when provided`);
    }
    if (!Number.isFinite(sortOrder)) {
      throw new Error(`packages[${index}].sortOrder must be a number`);
    }
    if (badge && badge.length > 40) {
      throw new Error(`packages[${index}].badge can have max 40 characters`);
    }

    return {
      coins,
      tier1PriceInr: Math.round(tier1PriceInr),
      tier2PriceInr: Math.round(tier2PriceInr),
      oldPriceInr: oldPriceInr === undefined ? undefined : Math.round(oldPriceInr),
      badge,
      isActive,
      sortOrder: Math.round(sortOrder),
    };
  });
}

// ══════════════════════════════════════════════════════════════════════════
// PUT /admin/wallet-pricing — Update wallet package tier pricing (live)
// ══════════════════════════════════════════════════════════════════════════
export const updateWalletPricing = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const adminUser = await getAdminUser(req);
    const normalizedPackages = normalizeWalletPackages(req.body?.packages);

    const config = await getOrCreateWalletPricingConfig();
    config.packages = normalizedPackages;
    if (adminUser?._id) {
      config.updatedByAdminId = adminUser._id;
    }
    await config.save();

    await logAdminAction(
      adminUser,
      'WALLET_PRICING_UPDATED',
      'wallet_pricing',
      config._id.toString(),
      'Updated wallet coin package pricing',
      {
        packageCount: normalizedPackages.length,
      }
    );

    try {
      const io = getIO();
      io.emit('wallet_pricing_updated', {
        updatedAt: config.updatedAt.toISOString(),
        updatedByAdminId: adminUser?._id?.toString() || null,
      });
      io.of('/admin').emit('wallet_pricing_updated', {
        updatedAt: config.updatedAt.toISOString(),
        updatedByAdminId: adminUser?._id?.toString() || null,
      });
    } catch (socketErr) {
      console.warn('⚠️ [ADMIN] Failed to emit wallet_pricing_updated:', socketErr);
    }

    res.json({
      success: true,
      data: {
        packages: normalizedPackages.sort((a, b) => {
          if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
          return a.coins - b.coins;
        }),
        updatedAt: config.updatedAt.toISOString(),
        updatedByAdminId: adminUser?._id?.toString() || null,
      },
    });
  } catch (error) {
    console.error('❌ [ADMIN] Update wallet pricing error:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(400).json({ success: false, error: message });
  }
};

async function computeCoinEconomy() {
  const thirtyDaysAgo = daysAgo(30);

  const [
    totalInCirculation,
    allTimeMinted,
    allTimeBurned,
    topSpenders,
    topEarners,
    dailyFlow,
    recentLargeTransactions,
    failedTransactions,
  ] = await Promise.all([
    User.aggregate([{ $group: { _id: null, total: { $sum: '$coins' } } }]),
    CoinTransaction.aggregate([{ $match: { type: 'credit', status: 'completed' } }, { $group: { _id: null, total: { $sum: '$coins' }, count: { $sum: 1 } } }]),
    CoinTransaction.aggregate([{ $match: { type: 'debit', status: 'completed' } }, { $group: { _id: null, total: { $sum: '$coins' }, count: { $sum: 1 } } }]),
    CoinTransaction.aggregate([
      { $match: { type: 'debit', status: 'completed', createdAt: { $gte: thirtyDaysAgo } } },
      { $group: { _id: '$userId', totalSpent: { $sum: '$coins' }, txCount: { $sum: 1 } } },
      { $sort: { totalSpent: -1 } },
      { $limit: 10 },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      { $project: { userId: '$_id', totalSpent: 1, txCount: 1, username: '$user.username', email: '$user.email', role: '$user.role' } },
    ]),
    CoinTransaction.aggregate([
      { $match: { type: 'credit', status: 'completed', createdAt: { $gte: thirtyDaysAgo } } },
      { $group: { _id: '$userId', totalEarned: { $sum: '$coins' }, txCount: { $sum: 1 } } },
      { $sort: { totalEarned: -1 } },
      { $limit: 10 },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      { $project: { userId: '$_id', totalEarned: 1, txCount: 1, username: '$user.username', email: '$user.email', role: '$user.role' } },
    ]),
    CoinTransaction.aggregate([
      { $match: { createdAt: { $gte: thirtyDaysAgo }, status: 'completed' } },
      { $group: { _id: { date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, type: '$type' }, total: { $sum: '$coins' }, count: { $sum: 1 } } },
      { $sort: { '_id.date': 1 } },
    ]),
    CoinTransaction.find({ coins: { $gt: 50 } }).sort({ createdAt: -1 }).limit(20).populate('userId', 'username email role').lean(),
    CoinTransaction.find({ status: 'failed' }).sort({ createdAt: -1 }).limit(20).lean(),
  ]);

  const dailyFlowMap: Record<string, { credited: number; debited: number; creditCount: number; debitCount: number }> = {};
  for (const row of dailyFlow) {
    const date = row._id.date;
    if (!dailyFlowMap[date]) dailyFlowMap[date] = { credited: 0, debited: 0, creditCount: 0, debitCount: 0 };
    if (row._id.type === 'credit') { dailyFlowMap[date].credited = row.total; dailyFlowMap[date].creditCount = row.count; }
    else { dailyFlowMap[date].debited = row.total; dailyFlowMap[date].debitCount = row.count; }
  }

  return {
    totalInCirculation: totalInCirculation[0]?.total ?? 0,
    allTimeMinted: allTimeMinted[0]?.total ?? 0,
    allTimeMintedCount: allTimeMinted[0]?.count ?? 0,
    allTimeBurned: allTimeBurned[0]?.total ?? 0,
    allTimeBurnedCount: allTimeBurned[0]?.count ?? 0,
    topSpenders: topSpenders.map((s: any) => ({ userId: s.userId?.toString(), username: s.username, email: s.email, role: s.role, totalSpent: s.totalSpent, txCount: s.txCount })),
    topEarners: topEarners.map((e: any) => ({ userId: e.userId?.toString(), username: e.username, email: e.email, role: e.role, totalEarned: e.totalEarned, txCount: e.txCount })),
    dailyFlow: Object.entries(dailyFlowMap).map(([date, data]) => ({ date, ...data })).sort((a, b) => a.date.localeCompare(b.date)),
    recentLargeTransactions: recentLargeTransactions.map((t: any) => ({
      id: t._id.toString(), transactionId: t.transactionId, type: t.type, coins: t.coins, source: t.source, description: t.description, status: t.status,
      user: t.userId ? { username: (t.userId as any).username, email: (t.userId as any).email, role: (t.userId as any).role } : null,
      createdAt: t.createdAt,
    })),
    failedTransactions: failedTransactions.map((t) => ({ id: t._id.toString(), transactionId: t.transactionId, type: t.type, coins: t.coins, source: t.source, description: t.description, createdAt: t.createdAt })),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// GET /admin/calls — Call history with anomaly detection
// (Not cached — paginated + filtered, always fresh)
// ══════════════════════════════════════════════════════════════════════════
export const getCallsAdmin = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const skip = (page - 1) * limit;
    const anomalyOnly = req.query.anomaly === 'true';

    const filter: any = { ownerRole: 'user' };
    if (anomalyOnly) {
      filter.$or = [
        { durationSeconds: 0, coinsDeducted: { $gt: 0 } },
        { durationSeconds: { $lt: 5 }, coinsDeducted: { $gt: 10 } },
      ];
    }

    const [calls, total] = await Promise.all([
      CallHistory.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      CallHistory.countDocuments(filter),
    ]);

    const allIds = [...new Set(calls.flatMap((c) => [c.ownerUserId.toString(), c.otherUserId.toString()]))];
    const usersForCalls = await User.find({ _id: { $in: allIds } }).select('username email phone role').lean();
    const userLookup = new Map(usersForCalls.map((u) => [u._id.toString(), u]));

    // Check which calls already have refunds (batch)
    const callIds = calls.map((c) => c.callId);
    const existingRefunds = callIds.length > 0
      ? await CoinTransaction.find({
          callId: { $in: callIds },
          source: 'admin',
          description: { $regex: /^REFUND/ },
        })
          .select('callId')
          .lean()
      : [];
    const refundedCallIds = new Set(existingRefunds.map((r) => r.callId));

    res.json({
      success: true,
      data: {
        calls: calls.map((c) => {
          const owner = userLookup.get(c.ownerUserId.toString());
          const other = userLookup.get(c.otherUserId.toString());
          return {
            callId: c.callId,
            ownerUserId: c.ownerUserId.toString(),
            ownerUsername: owner?.username || owner?.email || 'Unknown',
            otherUserId: c.otherUserId.toString(),
            otherName: c.otherName,
            otherUsername: other?.username || other?.email || 'Unknown',
            ownerRole: c.ownerRole,
            durationSeconds: c.durationSeconds,
            durationFormatted: c.durationSeconds >= 60
              ? `${Math.floor(c.durationSeconds / 60)}m ${c.durationSeconds % 60}s`
              : `${c.durationSeconds}s`,
            coinsDeducted: c.coinsDeducted,
            coinsEarned: c.coinsEarned,
            createdAt: c.createdAt,
            isZeroDuration: c.durationSeconds === 0,
            isVeryShort: c.durationSeconds > 0 && c.durationSeconds < 10,
            isSuspicious: c.durationSeconds === 0 && c.coinsDeducted > 0,
            isRefunded: refundedCallIds.has(c.callId),
          };
        }),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    console.error('❌ [ADMIN] Calls error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// GET /admin/system/health — System health snapshot
// (Never cached — must be live)
// ══════════════════════════════════════════════════════════════════════════
export const getSystemHealth = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const checks: Record<string, { status: string; latencyMs?: number; details?: string }> = {};

    const mongoStart = Date.now();
    try {
      await mongoose.connection.db!.admin().ping();
      checks.mongodb = { status: 'ok', latencyMs: Date.now() - mongoStart };
    } catch (err: any) {
      checks.mongodb = { status: 'error', details: err.message };
    }

    const redisStart = Date.now();
    try {
      const redis = getRedis();
      await redis.ping();
      checks.redis = { status: 'ok', latencyMs: Date.now() - redisStart };
    } catch (err: any) {
      checks.redis = { status: 'error', details: err.message };
    }

    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const [onlineCreators, recentTransactions, recentCalls, failedTransactions] = await Promise.all([
      Creator.countDocuments({ isOnline: true }),
      CoinTransaction.countDocuments({ createdAt: { $gte: fiveMinAgo } }),
      CallHistory.countDocuments({ createdAt: { $gte: oneHourAgo }, ownerRole: 'user' }),
      CoinTransaction.countDocuments({ status: 'failed', createdAt: { $gte: oneHourAgo } }),
    ]);

    const negativeBalanceUsers = await User.countDocuments({ coins: { $lt: 0 } });

    // Batch balance integrity check (up to 20 users)
    const balanceCheck = await batchVerifyBalances(20);

    res.json({
      success: true,
      data: {
        services: checks,
        platform: {
          onlineCreators,
          recentTransactions5m: recentTransactions,
          recentCalls1h: recentCalls,
          failedTransactions1h: failedTransactions,
          negativeBalanceUsers,
          balanceDiscrepancies: `${balanceCheck.mismatchCount}/${balanceCheck.totalChecked} sampled`,
          balanceMismatchFlag: balanceCheck.mismatchCount > 0,
          balanceMismatches: balanceCheck.mismatches,
        },
        serverTime: new Date().toISOString(),
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
      },
    });
  } catch (error) {
    console.error('❌ [ADMIN] System health error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// GET /admin/realtime-metrics — Live operational counters (never cached)
// ══════════════════════════════════════════════════════════════════════════
export const getRealtimeMetrics = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);

    // Count active billing sessions
    let activeBillingSessions = 0;
    try {
      // Count recent unsettled calls as a proxy for active billing sessions
      const recentActiveCalls = await CallHistory.countDocuments({
        createdAt: { $gte: fiveMinAgo },
        durationSeconds: 0, // still active (not yet settled)
        ownerRole: 'user',
      });
      activeBillingSessions = recentActiveCalls;
    } catch (err) {
      console.warn('⚠️ [ADMIN] Failed to count active billing sessions:', err);
    }

    const [
      onlineCreators,
      pendingWithdrawals,
      openSupportTickets,
      recentCalls5m,
    ] = await Promise.all([
      Creator.countDocuments({ isOnline: true }),
      Withdrawal.countDocuments({ status: 'pending' }),
      SupportTicket.countDocuments({ status: { $in: ['open', 'in_progress'] } }),
      CallHistory.countDocuments({ createdAt: { $gte: fiveMinAgo }, ownerRole: 'user' }),
    ]);

    res.json({
      success: true,
      data: {
        activeCalls: recentCalls5m,
        activeBillingSessions,
        onlineCreators,
        pendingWithdrawals,
        openSupportTickets,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('❌ [ADMIN] Realtime metrics error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// GET /admin/actions/log — Admin action audit log
// ══════════════════════════════════════════════════════════════════════════
export const getAdminActionLog = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, parseInt(req.query.limit as string) || 50);
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      AdminActionLog.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AdminActionLog.countDocuments({}),
    ]);

    res.json({
      success: true,
      data: {
        logs: logs.map((l) => ({
          id: l._id.toString(),
          adminEmail: l.adminEmail,
          action: l.action,
          targetType: l.targetType,
          targetId: l.targetId,
          reason: l.reason,
          details: l.details,
          createdAt: l.createdAt,
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    console.error('❌ [ADMIN] Action log error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// ADMIN ACTIONS (all with audit logging + cache invalidation)
// ══════════════════════════════════════════════════════════════════════════

/**
 * POST /admin/users/:id/adjust-coins
 * Body: { amount: number, reason: string }
 */
export const adjustUserCoins = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const { id } = req.params;
    const { amount, reason } = req.body;

    if (typeof amount !== 'number' || amount === 0) {
      res.status(400).json({ success: false, error: 'amount must be a non-zero number' });
      return;
    }
    if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
      res.status(400).json({ success: false, error: 'reason is required (min 5 characters)' });
      return;
    }

    const user = await User.findById(id);
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const adminUser = await getAdminUser(req);
    const oldCoins = user.coins;
    const isCredit = amount > 0;

    if (!isCredit && user.coins + amount < 0) {
      res.status(400).json({ success: false, error: `Cannot debit ${Math.abs(amount)} coins. User only has ${user.coins}` });
      return;
    }

    const txId = `admin_adjust_${randomUUID()}`;
    await new CoinTransaction({
      transactionId: txId,
      userId: user._id,
      type: isCredit ? 'credit' : 'debit',
      coins: Math.abs(amount),
      source: 'admin',
      description: `[Admin: ${adminUser?.email || 'unknown'}] ${reason.trim()}`,
      status: 'completed',
    }).save();

    user.coins = user.coins + amount;
    await user.save();

    // Audit log
    await logAdminAction(adminUser, 'COIN_ADJUSTMENT', 'user', user._id.toString(), reason.trim(), {
      transactionId: txId,
      oldBalance: oldCoins,
      newBalance: user.coins,
      adjustment: amount,
    });

    // Balance integrity check
    verifyUserBalance(user._id).catch(() => {});

    // Invalidate caches
    await invalidateAdminCaches('overview', 'coins', 'users_analytics');

    res.json({
      success: true,
      data: { transactionId: txId, userId: user._id.toString(), oldBalance: oldCoins, newBalance: user.coins, adjustment: amount, reason: reason.trim() },
    });
  } catch (error) {
    console.error('❌ [ADMIN] Adjust coins error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/**
 * POST /admin/creators/:id/force-offline
 */
export const forceCreatorOffline = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const { id } = req.params;
    const creator = await Creator.findById(id);
    if (!creator) {
      res.status(404).json({ success: false, error: 'Creator not found' });
      return;
    }

    const creatorUser = await User.findById(creator.userId);
    if (!creatorUser) {
      res.status(404).json({ success: false, error: 'Creator user not found' });
      return;
    }

    creator.isOnline = false;
    await creator.save();

    try {
      const io = getIO();
      await setCreatorAvailability(io, creatorUser.firebaseUid, 'busy');
    } catch (socketErr) {
      console.warn('⚠️ [ADMIN] Failed to broadcast availability:', socketErr);
    }

    const adminUser = await getAdminUser(req);
    await logAdminAction(adminUser, 'FORCE_OFFLINE', 'creator', creator._id.toString(), 'Admin forced creator offline', {
      creatorName: creator.name,
      creatorUserId: creator.userId.toString(),
    });

    // Invalidate caches
    await invalidateAdminCaches('overview', 'creators_performance');

    res.json({
      success: true,
      data: { creatorId: creator._id.toString(), name: creator.name, isOnline: false },
    });
  } catch (error) {
    console.error('❌ [ADMIN] Force offline error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/**
 * POST /admin/calls/:callId/refund
 * Body: { reason: string }
 *
 * Policy guards:
 * - Cannot refund calls older than REFUND_MAX_AGE_DAYS
 * - Cannot refund already-refunded calls (idempotent)
 * - Cannot refund 0-coin calls
 *
 * Returns pre-refund diff for UI confirmation.
 */
export const refundCall = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const { callId } = req.params;
    const { reason } = req.body;

    if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
      res.status(400).json({ success: false, error: 'reason is required (min 5 characters)' });
      return;
    }

    // Find user-side call record
    const userCall = await CallHistory.findOne({ callId, ownerRole: 'user' });
    if (!userCall) {
      res.status(404).json({ success: false, error: 'Call not found' });
      return;
    }

    // ── Policy guard: age ──────────────────────────────────────────
    const callAge = (Date.now() - new Date(userCall.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    if (callAge > REFUND_MAX_AGE_DAYS) {
      res.status(400).json({
        success: false,
        error: `Cannot refund calls older than ${REFUND_MAX_AGE_DAYS} days (this call is ${Math.round(callAge)}d old)`,
      });
      return;
    }

    // ── Policy guard: zero coins ───────────────────────────────────
    if (userCall.coinsDeducted === 0) {
      res.status(400).json({ success: false, error: 'Nothing to refund (0 coins deducted)' });
      return;
    }

    // ── Policy guard: already refunded ─────────────────────────────
    const existingRefund = await CoinTransaction.findOne({
      callId,
      source: 'admin',
      description: { $regex: /^REFUND/ },
    });
    if (existingRefund) {
      res.status(409).json({ success: false, error: 'Call already refunded' });
      return;
    }

    const adminUser = await getAdminUser(req);
    const refundAmount = userCall.coinsDeducted;

    // Get creator-side call record
    const creatorCall = await CallHistory.findOne({ callId, ownerRole: 'creator' });

    // ── Execute refund: credit user ────────────────────────────────
    const user = await User.findById(userCall.ownerUserId);
    const userOldBalance = user?.coins ?? 0;
    if (user) {
      await new CoinTransaction({
        transactionId: `refund_user_${callId}_${randomUUID()}`,
        userId: user._id,
        type: 'credit',
        coins: refundAmount,
        source: 'admin',
        description: `REFUND call ${callId} by ${adminUser?.email || 'admin'}: ${reason.trim()}`,
        callId,
        status: 'completed',
      }).save();
      user.coins += refundAmount;
      await user.save();
    }

    // ── Execute refund: debit creator earnings ─────────────────────
    let creatorOldBalance: number | null = null;
    let creatorNewBalance: number | null = null;
    if (creatorCall && creatorCall.coinsEarned > 0) {
      const creatorUser = await User.findById(creatorCall.ownerUserId);
      if (creatorUser) {
        creatorOldBalance = creatorUser.coins;
        const debitAmount = Math.min(creatorCall.coinsEarned, creatorUser.coins); // Don't go negative
        if (debitAmount > 0) {
          await new CoinTransaction({
            transactionId: `refund_creator_${callId}_${randomUUID()}`,
            userId: creatorUser._id,
            type: 'debit',
            coins: debitAmount,
            source: 'admin',
            description: `REFUND clawback call ${callId} by ${adminUser?.email || 'admin'}: ${reason.trim()}`,
            callId,
            status: 'completed',
          }).save();
          creatorUser.coins -= debitAmount;
          await creatorUser.save();
          creatorNewBalance = creatorUser.coins;
        }
      }
    }

    // Audit log
    await logAdminAction(adminUser, 'CALL_REFUND', 'call', callId, reason.trim(), {
      refundAmount,
      userId: userCall.ownerUserId.toString(),
      userOldBalance,
      userNewBalance: user?.coins ?? userOldBalance,
      creatorUserId: creatorCall?.ownerUserId?.toString() || null,
      creatorOldBalance,
      creatorNewBalance,
      callDuration: userCall.durationSeconds,
      callCreatedAt: userCall.createdAt,
    });

    // Balance integrity checks (fire-and-forget)
    if (user) verifyUserBalance(user._id).catch(() => {});
    if (creatorCall?.ownerUserId) verifyUserBalance(creatorCall.ownerUserId).catch(() => {});

    // Invalidate caches
    await invalidateAdminCaches('overview', 'coins', 'creators_performance');

    res.json({
      success: true,
      data: {
        callId,
        refundedAmount: refundAmount,
        userId: userCall.ownerUserId.toString(),
        userBalanceBefore: userOldBalance,
        userBalanceAfter: user?.coins ?? userOldBalance,
        creatorClawback: creatorOldBalance !== null ? {
          creatorUserId: creatorCall?.ownerUserId?.toString(),
          balanceBefore: creatorOldBalance,
          balanceAfter: creatorNewBalance,
        } : null,
        reason: reason.trim(),
      },
    });
  } catch (error) {
    console.error('❌ [ADMIN] Refund call error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// GET /admin/calls/:callId/refund-preview — Pre-refund impact preview
// ══════════════════════════════════════════════════════════════════════════
export const getRefundPreview = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const { callId } = req.params;

    const userCall = await CallHistory.findOne({ callId, ownerRole: 'user' });
    if (!userCall) {
      res.status(404).json({ success: false, error: 'Call not found' });
      return;
    }

    const creatorCall = await CallHistory.findOne({ callId, ownerRole: 'creator' });
    const user = await User.findById(userCall.ownerUserId).select('username email coins').lean();
    const creatorUser = creatorCall ? await User.findById(creatorCall.ownerUserId).select('username email coins').lean() : null;

    // Check if already refunded
    const existingRefund = await CoinTransaction.findOne({
      callId,
      source: 'admin',
      description: { $regex: /^REFUND/ },
    });

    // Check age
    const callAge = (Date.now() - new Date(userCall.createdAt).getTime()) / (1000 * 60 * 60 * 24);

    res.json({
      success: true,
      data: {
        callId,
        canRefund: !existingRefund && userCall.coinsDeducted > 0 && callAge <= REFUND_MAX_AGE_DAYS,
        blockReason: existingRefund
          ? 'Already refunded'
          : userCall.coinsDeducted === 0
          ? 'No coins deducted'
          : callAge > REFUND_MAX_AGE_DAYS
          ? `Call too old (${Math.round(callAge)}d > ${REFUND_MAX_AGE_DAYS}d)`
          : null,
        call: {
          durationSeconds: userCall.durationSeconds,
          coinsDeducted: userCall.coinsDeducted,
          createdAt: userCall.createdAt,
          ageDays: Math.round(callAge * 10) / 10,
        },
        userImpact: user ? {
          userId: user._id.toString(),
          username: user.username || user.email || 'Unknown',
          currentBalance: user.coins,
          afterRefund: user.coins + userCall.coinsDeducted,
        } : null,
        creatorImpact: creatorUser && creatorCall ? {
          userId: creatorUser._id.toString(),
          username: creatorUser.username || creatorUser.email || 'Unknown',
          currentBalance: creatorUser.coins,
          clawbackAmount: Math.min(creatorCall.coinsEarned, creatorUser.coins),
          afterClawback: creatorUser.coins - Math.min(creatorCall.coinsEarned, creatorUser.coins),
        } : null,
      },
    });
  } catch (error) {
    console.error('❌ [ADMIN] Refund preview error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// WITHDRAWAL MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /admin/withdrawals
 *
 * List all withdrawals with optional status filter.
 * Query params: ?status=pending|approved|rejected|paid
 */
/**
 * Helper: resolve a withdrawal's creator info regardless of whether it was
 * created by the main backend (has creatorUserId) or creatorB (has creatorFirebaseUid).
 */
async function resolveWithdrawalCreator(w: any): Promise<{
  userId: string | null;
  firebaseUid: string | null;
  user: any | null;
  creator: any | null;
}> {
  // Case 1: main backend withdrawal — has creatorUserId
  if (w.creatorUserId) {
    const user = await User.findById(w.creatorUserId).select('username email phone coins role firebaseUid').lean();
    const creator = await Creator.findOne({ userId: w.creatorUserId }).select('userId name photo earningsCoins').lean();
    return {
      userId: w.creatorUserId.toString(),
      firebaseUid: user?.firebaseUid || w.creatorFirebaseUid || null,
      user,
      creator,
    };
  }

  // Case 2: creatorB withdrawal — only has creatorFirebaseUid
  if (w.creatorFirebaseUid) {
    const user = await User.findOne({ firebaseUid: w.creatorFirebaseUid }).select('username email phone coins role firebaseUid').lean();
    const creator = user
      ? await Creator.findOne({ userId: user._id }).select('userId name photo earningsCoins').lean()
      : null;
    return {
      userId: user?._id?.toString() || null,
      firebaseUid: w.creatorFirebaseUid,
      user,
      creator,
    };
  }

  return { userId: null, firebaseUid: null, user: null, creator: null };
}

export const getWithdrawals = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const statusFilter = req.query.status as string | undefined;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const skip = (page - 1) * limit;

    const filter: any = {};
    if (statusFilter && ['pending', 'approved', 'rejected', 'paid'].includes(statusFilter)) {
      filter.status = statusFilter;
    }

    const [withdrawals, total] = await Promise.all([
      Withdrawal.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Withdrawal.countDocuments(filter),
    ]);

    // Resolve creator info for each withdrawal (handles both creatorUserId and creatorFirebaseUid)
    const enrichedWithdrawals = await Promise.all(
      withdrawals.map(async (w) => {
        const resolved = await resolveWithdrawalCreator(w);
        return {
          id: w._id.toString(),
          creatorUserId: resolved.userId || '',
          creatorName: resolved.creator?.name || resolved.user?.username || 'Unknown',
          creatorEmail: resolved.user?.email || null,
          creatorPhone: resolved.user?.phone || null,
          // Use User.coins as primary source (actual balance), fallback to Creator.earningsCoins if user not found
          creatorCurrentBalance: resolved.user?.coins ?? resolved.creator?.earningsCoins ?? 0,
          amount: w.amount,
          status: w.status,
          requestedAt: (w as any).requestedAt || w.createdAt,
          processedAt: w.processedAt || null,
          adminUserId: w.adminUserId?.toString() || null,
          notes: w.notes || (w as any).note || null,
          transactionId: w.transactionId || null,
          createdAt: w.createdAt,
          // Withdrawal details
          name: (w as any).name || null,
          number: (w as any).number || null,
          upi: (w as any).upi || null,
          accountNumber: (w as any).accountNumber || null,
          ifsc: (w as any).ifsc || null,
        };
      })
    );

    // Summary stats
    const [pendingCount, totalWithdrawn30d, topWithdrawingCreators] = await Promise.all([
      Withdrawal.countDocuments({ status: 'pending' }),
      Withdrawal.aggregate([
        {
          $match: {
            status: { $in: ['approved', 'paid'] },
            createdAt: { $gte: daysAgo(30) },
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Withdrawal.aggregate([
        {
          $match: {
            status: { $in: ['approved', 'paid'] },
            createdAt: { $gte: daysAgo(30) },
          },
        },
        {
          $group: {
            _id: { $ifNull: ['$creatorUserId', '$creatorFirebaseUid'] },
            totalWithdrawn: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
        { $sort: { totalWithdrawn: -1 } },
        { $limit: 10 },
      ]),
    ]);

    // Enrich top withdrawing creators
    const topCreatorEnriched = await Promise.all(
      topWithdrawingCreators.map(async (t: any) => {
        const idVal = t._id;
        let user: any = null;
        let creator: any = null;

        // Try as ObjectId first, then as firebaseUid string
        if (mongoose.Types.ObjectId.isValid(idVal)) {
          user = await User.findById(idVal).select('username email').lean();
          creator = await Creator.findOne({ userId: idVal }).select('userId name').lean();
        }
        if (!user && typeof idVal === 'string') {
          user = await User.findOne({ firebaseUid: idVal }).select('username email').lean();
          if (user) {
            creator = await Creator.findOne({ userId: user._id }).select('userId name').lean();
          }
        }

        return {
          creatorUserId: user?._id?.toString() || idVal?.toString() || '',
          name: creator?.name || user?.username || 'Unknown',
          email: user?.email || null,
          totalWithdrawn: t.totalWithdrawn,
          withdrawalCount: t.count,
        };
      })
    );

    res.json({
      success: true,
      data: {
        withdrawals: enrichedWithdrawals,
        summary: {
          pendingCount,
          totalWithdrawn30d: totalWithdrawn30d[0]?.total ?? 0,
          topWithdrawingCreators: topCreatorEnriched,
        },
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    console.error('❌ [ADMIN] Get withdrawals error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/**
 * POST /admin/withdrawals/:id/approve
 *
 * Approves a pending withdrawal:
 *   - Deducts coins from creator
 *   - Creates CoinTransaction (type: debit, source: withdrawal)
 *   - Logs AdminActionLog
 *   - Sets status to 'approved'
 */
export const approveWithdrawal = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const { id } = req.params;
    const { notes } = req.body;

    const withdrawal = await Withdrawal.findById(id);
    if (!withdrawal) {
      res.status(404).json({ success: false, error: 'Withdrawal not found' });
      return;
    }

    if (withdrawal.status !== 'pending') {
      res.status(400).json({
        success: false,
        error: `Cannot approve withdrawal with status '${withdrawal.status}'. Only pending withdrawals can be approved.`,
      });
      return;
    }

    // Resolve the creator user — supports both creatorUserId and creatorFirebaseUid
    let creatorUser: any = null;
    if (withdrawal.creatorUserId) {
      creatorUser = await User.findById(withdrawal.creatorUserId);
    } else if ((withdrawal as any).creatorFirebaseUid) {
      creatorUser = await User.findOne({ firebaseUid: (withdrawal as any).creatorFirebaseUid });
    }

    if (!creatorUser) {
      res.status(404).json({ success: false, error: 'Creator user not found' });
      return;
    }

    // Find the Creator document to update earningsCoins
    const creatorDoc = await Creator.findOne({ userId: creatorUser._id });

    // Verify balance is sufficient (use User.coins as primary source - actual available balance)
    // Creator.earningsCoins is a separate tracking field that may be 0 or out of sync
    const availableBalance = creatorUser.coins;
    if (availableBalance < withdrawal.amount) {
      res.status(400).json({
        success: false,
        error: `Creator balance (${availableBalance}) is less than withdrawal amount (${withdrawal.amount}). Cannot approve.`,
      });
      return;
    }

    const adminUser = await getAdminUser(req);
    const txId = `withdrawal_${withdrawal._id}_${randomUUID()}`;
    const oldCoins = creatorUser.coins;
    const oldEarnings = creatorDoc?.earningsCoins ?? 0;

    // Create CoinTransaction (debit)
    await new CoinTransaction({
      transactionId: txId,
      userId: creatorUser._id,
      type: 'debit',
      coins: withdrawal.amount,
      source: 'withdrawal',
      description: `Withdrawal approved by ${adminUser?.email || 'admin'}${notes ? ': ' + notes.trim() : ''}`,
      status: 'completed',
    }).save();

    // Deduct coins from User balance
    creatorUser.coins -= withdrawal.amount;
    await creatorUser.save();

    // Reset Creator.earningsCoins to 0 (total earnings resets on successful withdrawal)
    if (creatorDoc) {
      creatorDoc.earningsCoins = Math.max(0, creatorDoc.earningsCoins - withdrawal.amount);
      await creatorDoc.save();
    }

    // Update withdrawal record
    withdrawal.status = 'approved';
    withdrawal.processedAt = new Date();
    withdrawal.adminUserId = adminUser?._id;
    withdrawal.notes = notes?.trim() || undefined;
    withdrawal.transactionId = txId;
    // Backfill creatorUserId if it was missing (creatorB withdrawal)
    if (!withdrawal.creatorUserId) {
      withdrawal.creatorUserId = creatorUser._id;
    }
    await withdrawal.save();

    // Audit log
    await logAdminAction(adminUser, 'WITHDRAWAL_APPROVED', 'withdrawal', withdrawal._id.toString(), notes?.trim() || 'Withdrawal approved', {
      transactionId: txId,
      creatorUserId: creatorUser._id.toString(),
      amount: withdrawal.amount,
      oldBalance: oldCoins,
      newBalance: creatorUser.coins,
      oldEarnings,
      newEarnings: creatorDoc?.earningsCoins ?? 0,
    });

    // Balance integrity check (fire-and-forget)
    verifyUserBalance(creatorUser._id).catch(() => {});

    // Emit coins_updated socket event so creator's app updates instantly
    try {
      const io = getIO();
      io.to(`user:${creatorUser.firebaseUid}`).emit('coins_updated', {
        userId: creatorUser._id.toString(),
        coins: creatorUser.coins,
      });
      console.log(`📡 [ADMIN] Emitted coins_updated to ${creatorUser.firebaseUid} (${creatorUser.coins} coins)`);
    } catch (socketErr) {
      console.error('⚠️ [ADMIN] Failed to emit coins_updated:', socketErr);
    }

    // Emit creator:data_updated to refresh creator dashboard (earnings, tasks, etc.)
    try {
      emitCreatorDataUpdated(creatorUser.firebaseUid, {
        reason: 'withdrawal_approved',
        coins: creatorUser.coins,
        withdrawalAmount: withdrawal.amount,
        withdrawalId: withdrawal._id.toString(),
      });
    } catch (emitErr) {
      console.error('⚠️ [ADMIN] Failed to emit creator:data_updated:', emitErr);
    }

    // Invalidate caches
    await invalidateAdminCaches('overview', 'coins', 'creators_performance');

    console.log(`✅ [ADMIN] Withdrawal ${id} approved. Creator ${creatorUser._id}: coins ${oldCoins} → ${creatorUser.coins}, earnings ${oldEarnings} → ${creatorDoc?.earningsCoins ?? 0}`);

    res.json({
      success: true,
      data: {
        withdrawalId: withdrawal._id.toString(),
        status: 'approved',
        amount: withdrawal.amount,
        transactionId: txId,
        creatorOldBalance: oldCoins,
        creatorNewBalance: creatorUser.coins,
      },
    });
  } catch (error) {
    console.error('❌ [ADMIN] Approve withdrawal error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/**
 * POST /admin/withdrawals/:id/reject
 *
 * Rejects a pending withdrawal (no coins deducted).
 */
export const rejectWithdrawal = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const { id } = req.params;
    const { notes } = req.body;

    if (!notes || typeof notes !== 'string' || notes.trim().length < 3) {
      res.status(400).json({ success: false, error: 'Notes/reason is required (min 3 characters)' });
      return;
    }

    const withdrawal = await Withdrawal.findById(id);
    if (!withdrawal) {
      res.status(404).json({ success: false, error: 'Withdrawal not found' });
      return;
    }

    if (withdrawal.status !== 'pending') {
      res.status(400).json({
        success: false,
        error: `Cannot reject withdrawal with status '${withdrawal.status}'. Only pending withdrawals can be rejected.`,
      });
      return;
    }

    const adminUser = await getAdminUser(req);

    withdrawal.status = 'rejected';
    withdrawal.adminUserId = adminUser?._id;
    withdrawal.notes = notes.trim();
    withdrawal.processedAt = new Date();
    await withdrawal.save();

    // Audit log
    await logAdminAction(adminUser, 'WITHDRAWAL_REJECTED', 'withdrawal', withdrawal._id.toString(), notes.trim(), {
      creatorUserId: withdrawal.creatorUserId?.toString() || (withdrawal as any).creatorFirebaseUid || 'unknown',
      amount: withdrawal.amount,
    });

    console.log(`✅ [ADMIN] Withdrawal ${id} rejected. Reason: ${notes.trim()}`);

    res.json({
      success: true,
      data: {
        withdrawalId: withdrawal._id.toString(),
        status: 'rejected',
        amount: withdrawal.amount,
        notes: notes.trim(),
      },
    });
  } catch (error) {
    console.error('❌ [ADMIN] Reject withdrawal error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/**
 * POST /admin/withdrawals/:id/mark-paid
 *
 * Marks an approved withdrawal as paid (external payment completed).
 * Sets processedAt timestamp.
 */
export const markWithdrawalPaid = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const { id } = req.params;
    const { notes } = req.body;

    const withdrawal = await Withdrawal.findById(id);
    if (!withdrawal) {
      res.status(404).json({ success: false, error: 'Withdrawal not found' });
      return;
    }

    if (withdrawal.status !== 'approved') {
      res.status(400).json({
        success: false,
        error: `Cannot mark as paid. Withdrawal status is '${withdrawal.status}', expected 'approved'.`,
      });
      return;
    }

    const adminUser = await getAdminUser(req);

    withdrawal.status = 'paid';
    withdrawal.processedAt = new Date();
    if (notes?.trim()) {
      withdrawal.notes = (withdrawal.notes || '') + (withdrawal.notes ? ' | ' : '') + `Paid: ${notes.trim()}`;
    }
    await withdrawal.save();

    // Ensure Creator.earningsCoins is reset to 0 on successful payment
    let creatorUser: any = null;
    if (withdrawal.creatorUserId) {
      creatorUser = await User.findById(withdrawal.creatorUserId).lean();
    } else if ((withdrawal as any).creatorFirebaseUid) {
      creatorUser = await User.findOne({ firebaseUid: (withdrawal as any).creatorFirebaseUid }).lean();
    }
    if (creatorUser) {
      const creatorDoc = await Creator.findOne({ userId: creatorUser._id });
      if (creatorDoc && creatorDoc.earningsCoins > 0) {
        creatorDoc.earningsCoins = Math.max(0, creatorDoc.earningsCoins - withdrawal.amount);
        await creatorDoc.save();
      }
    }

    // Audit log
    await logAdminAction(adminUser, 'WITHDRAWAL_PAID', 'withdrawal', withdrawal._id.toString(), notes?.trim() || 'Marked as paid', {
      creatorUserId: withdrawal.creatorUserId?.toString() || (withdrawal as any).creatorFirebaseUid || 'unknown',
      amount: withdrawal.amount,
      processedAt: withdrawal.processedAt.toISOString(),
    });

    console.log(`✅ [ADMIN] Withdrawal ${id} marked as paid`);

    // Invalidate caches
    await invalidateAdminCaches('overview', 'coins', 'creators_performance');

    res.json({
      success: true,
      data: {
        withdrawalId: withdrawal._id.toString(),
        status: 'paid',
        amount: withdrawal.amount,
        processedAt: withdrawal.processedAt.toISOString(),
      },
    });
  } catch (error) {
    console.error('❌ [ADMIN] Mark withdrawal paid error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// SUPPORT TICKET MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /admin/support
 *
 * List all support tickets with filtering.
 * Query params:
 *   ?role=user|creator
 *   &status=open|in_progress|resolved|closed
 *   &priority=low|medium|high|urgent
 *   &source=chat|post_call|other
 *   &creatorReports=true|false
 */
export const getSupportTickets = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const roleFilter = req.query.role as string | undefined;
    const statusFilter = req.query.status as string | undefined;
    const priorityFilter = req.query.priority as string | undefined;
    const sourceFilter = req.query.source as string | undefined;
    const creatorReportsOnly = String(req.query.creatorReports || '').toLowerCase() === 'true';
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const skip = (page - 1) * limit;

    const filter: any = {};
    if (roleFilter && ['user', 'creator'].includes(roleFilter)) filter.role = roleFilter;
    if (statusFilter && ['open', 'in_progress', 'resolved', 'closed'].includes(statusFilter)) filter.status = statusFilter;
    if (priorityFilter && ['low', 'medium', 'high', 'urgent'].includes(priorityFilter)) filter.priority = priorityFilter;
    if (sourceFilter && ['chat', 'post_call', 'other'].includes(sourceFilter)) filter.source = sourceFilter;
    if (creatorReportsOnly) {
      filter.$or = [
        { reportedCreatorUserId: { $exists: true } },
        { reportedCreatorFirebaseUid: { $exists: true, $ne: null } },
      ];
    }

    const [tickets, total] = await Promise.all([
      SupportTicket.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      SupportTicket.countDocuments(filter),
    ]);

    // Enrich with user info
    const userIds = [...new Set(tickets.map((t) => t.userId.toString()))];
    const reportedCreatorUserIds = [
      ...new Set(
        tickets
          .map((t) => t.reportedCreatorUserId?.toString())
          .filter((v): v is string => !!v)
      ),
    ];
    const users = await User.find({ _id: { $in: userIds } })
      .select('username email phone role')
      .lean();
    const userMap = new Map(users.map((u) => [u._id.toString(), u]));
    
    // Log if any users are missing
    const missingUserIds = userIds.filter(id => !userMap.has(id));
    if (missingUserIds.length > 0) {
      console.warn(`⚠️ [ADMIN] ${missingUserIds.length} ticket(s) reference missing users:`, missingUserIds);
    }
    const reportedCreators =
      reportedCreatorUserIds.length > 0
        ? await User.find({ _id: { $in: reportedCreatorUserIds } })
            .select('username email firebaseUid')
            .lean()
        : [];
    const reportedCreatorMap = new Map(reportedCreators.map((u) => [u._id.toString(), u]));

    // Summary stats
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [
      openUserTickets,
      openCreatorTickets,
      highPriorityOpen,
      unassigned,
      agingTickets,
    ] = await Promise.all([
      SupportTicket.countDocuments({ role: 'user', status: { $in: ['open', 'in_progress'] } }),
      SupportTicket.countDocuments({ role: 'creator', status: { $in: ['open', 'in_progress'] } }),
      SupportTicket.countDocuments({ priority: { $in: ['high', 'urgent'] }, status: { $in: ['open', 'in_progress'] } }),
      SupportTicket.countDocuments({ assignedAdminId: { $exists: false }, status: { $in: ['open', 'in_progress'] } }),
      SupportTicket.countDocuments({ status: { $in: ['open', 'in_progress'] }, createdAt: { $lt: twentyFourHoursAgo } }),
    ]);

    res.json({
      success: true,
      data: {
        tickets: tickets.map((t) => {
          const user = userMap.get(t.userId.toString());
          // Better fallback: try username, email, phone, or userId
          const displayName = user?.username || 
                             user?.email || 
                             user?.phone || 
                             (user ? `User ${t.userId.toString().substring(0, 8)}` : 'Unknown');
          return {
            id: t._id.toString(),
            userId: t.userId.toString(),
            username: displayName,
            email: user?.email || null,
            phone: user?.phone || null,
            userRole: user?.role || null,
            role: t.role,
            category: t.category,
            subject: t.subject,
            message: t.message,
            status: t.status,
            priority: t.priority,
            assignedAdminId: t.assignedAdminId?.toString() || null,
            adminNotes: t.adminNotes || null,
            source: t.source || 'other',
            relatedCallId: t.relatedCallId || null,
            reportedCreatorUserId: t.reportedCreatorUserId?.toString() || null,
            reportedCreatorFirebaseUid:
              t.reportedCreatorFirebaseUid ||
              (t.reportedCreatorUserId
                ? reportedCreatorMap.get(t.reportedCreatorUserId.toString())?.firebaseUid || null
                : null),
            reportedCreatorName:
              t.reportedCreatorName ||
              (t.reportedCreatorUserId
                ? reportedCreatorMap.get(t.reportedCreatorUserId.toString())?.username ||
                  reportedCreatorMap.get(t.reportedCreatorUserId.toString())?.email ||
                  null
                : null),
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
          };
        }),
        summary: {
          openUserTickets,
          openCreatorTickets,
          highPriorityOpen,
          unassigned,
          agingOver24h: agingTickets,
        },
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    console.error('❌ [ADMIN] Get support tickets error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/**
 * PATCH /admin/support/:id/status
 *
 * Update a support ticket's status and optionally add admin notes.
 * Body: { status: string, adminNotes?: string }
 */
export const updateTicketStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const { id } = req.params;
    const { status, adminNotes } = req.body;

    const validStatuses = ['open', 'in_progress', 'resolved', 'closed'];
    if (!status || !validStatuses.includes(status)) {
      res.status(400).json({ success: false, error: `Status must be one of: ${validStatuses.join(', ')}` });
      return;
    }

    const ticket = await SupportTicket.findById(id);
    if (!ticket) {
      res.status(404).json({ success: false, error: 'Ticket not found' });
      return;
    }

    const oldStatus = ticket.status;
    ticket.status = status;
    if (adminNotes?.trim()) {
      ticket.adminNotes = (ticket.adminNotes || '') + (ticket.adminNotes ? '\n---\n' : '') + adminNotes.trim();
    }
    await ticket.save();

    const adminUser = await getAdminUser(req);
    await logAdminAction(adminUser, 'SUPPORT_STATUS_UPDATE', 'support', ticket._id.toString(), `Status: ${oldStatus} → ${status}`, {
      ticketId: ticket._id.toString(),
      oldStatus,
      newStatus: status,
      adminNotes: adminNotes?.trim() || null,
    });

    console.log(`✅ [ADMIN] Ticket ${id} status: ${oldStatus} → ${status}`);

    res.json({
      success: true,
      data: {
        ticketId: ticket._id.toString(),
        oldStatus,
        newStatus: status,
      },
    });
  } catch (error) {
    console.error('❌ [ADMIN] Update ticket status error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/**
 * PATCH /admin/support/:id/assign
 *
 * Assign a support ticket to an admin.
 * Body: { adminId: string } — or omit to unassign.
 */
export const assignTicket = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const { id } = req.params;
    const { adminId } = req.body;

    const ticket = await SupportTicket.findById(id);
    if (!ticket) {
      res.status(404).json({ success: false, error: 'Ticket not found' });
      return;
    }

    if (adminId) {
      // Verify the admin user exists and is an admin
      const assignee = await User.findById(adminId).lean();
      if (!assignee || assignee.role !== 'admin') {
        res.status(400).json({ success: false, error: 'Assignee must be a valid admin user' });
        return;
      }
      ticket.assignedAdminId = assignee._id;
    } else {
      ticket.assignedAdminId = undefined;
    }

    await ticket.save();

    const adminUser = await getAdminUser(req);
    await logAdminAction(adminUser, 'SUPPORT_ASSIGN', 'support', ticket._id.toString(), adminId ? `Assigned to ${adminId}` : 'Unassigned', {
      ticketId: ticket._id.toString(),
      assignedAdminId: adminId || null,
    });

    console.log(`✅ [ADMIN] Ticket ${id} assigned to ${adminId || 'nobody'}`);

    res.json({
      success: true,
      data: {
        ticketId: ticket._id.toString(),
        assignedAdminId: ticket.assignedAdminId?.toString() || null,
      },
    });
  } catch (error) {
    console.error('❌ [ADMIN] Assign ticket error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// PHASE 7 — DATA INTEGRITY CHECKS
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /admin/integrity-checks
 * Automated data-integrity checklist:
 *   • Paid chat messages → CoinTransaction exists
 *   • Video calls → CallHistory + CoinTransaction pair
 *   • Approved withdrawals → debit CoinTransaction exists
 *   • Support tickets → basic consistency
 */
export const getIntegrityChecks = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const thirtyDaysAgo = daysAgo(30);

    // 1) Chat billing integrity: paid messages with no matching CoinTransaction
    const paidChatTxCount = await CoinTransaction.countDocuments({
      source: 'chat_message',
      status: 'completed',
      createdAt: { $gte: thirtyDaysAgo },
    });

    // 2) Video call integrity: calls with coins > 0 that lack a CoinTransaction
    const callsWithCoins = await CallHistory.find({
      coinsDeducted: { $gt: 0 },
      createdAt: { $gte: thirtyDaysAgo },
      ownerRole: 'user',
    }).select('callId coinsDeducted').lean();

    const callIds = callsWithCoins.map((c: any) => c.callId);
    const callTxs = await CoinTransaction.find({
      source: 'video_call',
      callId: { $in: callIds },
      status: 'completed',
    }).select('callId').lean();
    const settledCallIds = new Set(callTxs.map((t: any) => t.callId));
    const unsettledCalls = callIds.filter((id: string) => !settledCallIds.has(id));

    // 3) Withdrawal integrity: approved/paid withdrawals that lack debit CoinTransaction
    const processedWithdrawals = await Withdrawal.find({
      status: { $in: ['approved', 'paid'] },
    }).select('_id amount creatorUserId creatorFirebaseUid').lean();

    let withdrawalMissingTx = 0;
    for (const w of processedWithdrawals) {
      // Resolve userId — may come from creatorUserId or creatorFirebaseUid
      let userId = (w as any).creatorUserId;
      if (!userId && (w as any).creatorFirebaseUid) {
        const u = await User.findOne({ firebaseUid: (w as any).creatorFirebaseUid }).select('_id').lean();
        userId = u?._id;
      }
      if (!userId) { withdrawalMissingTx++; continue; }

      const txExists = await CoinTransaction.exists({
        userId,
        source: 'withdrawal',
        type: 'debit',
        coins: (w as any).amount,
      });
      if (!txExists) withdrawalMissingTx++;
    }

    // 4) Support ticket consistency: open tickets older than 7 days with no assignment
    const sevenDaysAgo = daysAgo(7);
    const staleUnassignedTickets = await SupportTicket.countDocuments({
      status: 'open',
      assignedAdminId: { $exists: false },
      createdAt: { $lt: sevenDaysAgo },
    });

    // 5) Balance mismatch sample
    const balanceCheck = await batchVerifyBalances(100);

    const allPassed =
      unsettledCalls.length === 0 &&
      withdrawalMissingTx === 0 &&
      balanceCheck.mismatchCount === 0;

    res.json({
      success: true,
      data: {
        overallHealthy: allPassed,
        checks: {
          chatBilling: {
            paidChatTransactions30d: paidChatTxCount,
            status: 'ok',
          },
          videoCalls: {
            totalCallsWithCoins30d: callsWithCoins.length,
            unsettledCallIds: unsettledCalls.slice(0, 20),
            unsettledCount: unsettledCalls.length,
            status: unsettledCalls.length === 0 ? 'ok' : 'warning',
          },
          withdrawals: {
            processedCount: processedWithdrawals.length,
            missingDebitTxCount: withdrawalMissingTx,
            status: withdrawalMissingTx === 0 ? 'ok' : 'warning',
          },
          supportTickets: {
            staleUnassignedCount: staleUnassignedTickets,
            status: staleUnassignedTickets === 0 ? 'ok' : 'info',
          },
          balanceIntegrity: {
            checked: balanceCheck.totalChecked,
            mismatchCount: balanceCheck.mismatchCount,
            mismatches: balanceCheck.mismatches.slice(0, 10),
            status: balanceCheck.mismatchCount === 0 ? 'ok' : 'critical',
          },
        },
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('❌ [ADMIN] Integrity checks error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// PHASE 9 — SECURITY & ABUSE CONTROLS
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /admin/creators/performance
 * (Enhanced) — now includes abuse flags:
 *   - withdrawal cooldown check (1 per 24h)
 *   - support ticket rate (5 per day)
 *   - creators with ≥3 refund requests/week
 *   - creators with ≥50% short calls
 *
 * The existing `getCreatorsPerformance` already computes abuseSignals.
 * We add a dedicated GET /admin/security/flags endpoint instead.
 */
export const getSecurityFlags = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = daysAgo(30);

    // 1) Withdrawal cooldown violations: creators who requested >1 in 24h
    const withdrawalCooldownViolators = await Withdrawal.aggregate([
      { $match: { createdAt: { $gte: oneDayAgo } } },
      { $group: { _id: { $ifNull: ['$creatorUserId', '$creatorFirebaseUid'] }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]);

    // 2) Support ticket rate-limit: users who submitted >5 tickets today
    const supportRateLimitViolators = await SupportTicket.aggregate([
      { $match: { createdAt: { $gte: oneDayAgo } } },
      { $group: { _id: '$userId', count: { $sum: 1 } } },
      { $match: { count: { $gt: 5 } } },
    ]);

    // 3) Creators with ≥3 refund-related transactions in the past week
    const refundAbusers = await CoinTransaction.aggregate([
      {
        $match: {
          source: 'video_call',
          type: 'credit',
          description: { $regex: /refund/i },
          createdAt: { $gte: oneWeekAgo },
        },
      },
      { $group: { _id: '$userId', refundCount: { $sum: 1 } } },
      { $match: { refundCount: { $gte: 3 } } },
    ]);

    // 4) Creators with ≥50% short calls (<10s) in last 30d
    const creatorCallStats = await CallHistory.aggregate([
      { $match: { ownerRole: 'creator', createdAt: { $gte: thirtyDaysAgo } } },
      {
        $group: {
          _id: '$ownerUserId',
          totalCalls: { $sum: 1 },
          shortCalls: {
            $sum: { $cond: [{ $lt: ['$durationSeconds', 10] }, 1, 0] },
          },
        },
      },
      { $match: { totalCalls: { $gte: 5 } } }, // minimum sample size
      { $addFields: { shortPct: { $multiply: [{ $divide: ['$shortCalls', '$totalCalls'] }, 100] } } },
      { $match: { shortPct: { $gte: 50 } } },
      { $sort: { shortPct: -1 } },
      { $limit: 50 },
    ]);

    // Enrich with user info
    const enrichUser = async (userId: string) => {
      const u = await User.findById(userId).select('username email phone role').lean();
      return u ? { userId, username: (u as any).username, email: (u as any).email, role: (u as any).role } : { userId, username: null, email: null, role: null };
    };

    const withdrawalViolatorDetails = await Promise.all(
      withdrawalCooldownViolators.map(async (v: any) => ({
        ...(await enrichUser(v._id.toString())),
        withdrawalsIn24h: v.count,
      }))
    );

    const supportViolatorDetails = await Promise.all(
      supportRateLimitViolators.map(async (v: any) => ({
        ...(await enrichUser(v._id.toString())),
        ticketsIn24h: v.count,
      }))
    );

    const refundAbuserDetails = await Promise.all(
      refundAbusers.map(async (v: any) => ({
        ...(await enrichUser(v._id.toString())),
        refundsIn7d: v.refundCount,
      }))
    );

    const shortCallDetails = await Promise.all(
      creatorCallStats.map(async (v: any) => ({
        ...(await enrichUser(v._id.toString())),
        totalCalls: v.totalCalls,
        shortCalls: v.shortCalls,
        shortCallPct: Math.round(v.shortPct),
      }))
    );

    res.json({
      success: true,
      data: {
        withdrawalCooldownViolators: withdrawalViolatorDetails,
        supportRateLimitViolators: supportViolatorDetails,
        refundAbusers: refundAbuserDetails,
        shortCallAbusers: shortCallDetails,
        summary: {
          withdrawalCooldownViolations: withdrawalCooldownViolators.length,
          supportRateLimitViolations: supportRateLimitViolators.length,
          refundAbuserCount: refundAbusers.length,
          shortCallAbuserCount: creatorCallStats.length,
          totalFlags:
            withdrawalCooldownViolators.length +
            supportRateLimitViolators.length +
            refundAbusers.length +
            creatorCallStats.length,
        },
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('❌ [ADMIN] Security flags error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// PHASE 10 — FULL AUDIT REPORT
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /admin/full-audit-report
 * Comprehensive audit snapshot:
 *   - coinIntegrity (batch balance check)
 *   - balanceMismatchCount
 *   - negativeBalanceCount
 *   - unsettledCalls
 *   - pendingWithdrawals
 *   - openSupportTickets
 */
export const getFullAuditReport = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const [
      balanceCheck,
      negativeBalanceCount,
      pendingWithdrawals,
      totalWithdrawalsPaid,
      openSupportTickets,
      highPriorityTickets,
      totalUsers,
      totalCreators,
      totalTransactions,
      totalCalls,
    ] = await Promise.all([
      batchVerifyBalances(200),
      User.countDocuments({ coins: { $lt: 0 } }),
      Withdrawal.countDocuments({ status: 'pending' }),
      Withdrawal.countDocuments({ status: 'paid' }),
      SupportTicket.countDocuments({ status: { $in: ['open', 'in_progress'] } }),
      SupportTicket.countDocuments({ status: { $in: ['open', 'in_progress'] }, priority: 'high' }),
      User.countDocuments({}),
      Creator.countDocuments({}),
      CoinTransaction.countDocuments({}),
      CallHistory.countDocuments({ ownerRole: 'user' }),
    ]);

    // Count unsettled calls (recent calls with 0 duration that might still be active)
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const unsettledCalls = await CallHistory.countDocuments({
      durationSeconds: 0,
      ownerRole: 'user',
      createdAt: { $gte: fiveMinAgo },
    });

    // Coin circulation integrity
    const coinAgg = await CoinTransaction.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: '$type', total: { $sum: '$coins' }, count: { $sum: 1 } } },
    ]);
    const totalCredited = coinAgg.find((a: any) => a._id === 'credit')?.total || 0;
    const totalDebited = coinAgg.find((a: any) => a._id === 'debit')?.total || 0;
    const circulationBalance = await User.aggregate([
      { $group: { _id: null, total: { $sum: '$coins' } } },
    ]);
    const actualCirculation = circulationBalance[0]?.total || 0;
    const expectedCirculation = totalCredited - totalDebited;
    const circulationMismatch = Math.abs(actualCirculation - expectedCirculation);

    res.json({
      success: true,
      data: {
        coinIntegrity: {
          totalCredited,
          totalDebited,
          expectedCirculation,
          actualCirculation,
          circulationMismatch,
          circulationHealthy: circulationMismatch <= totalUsers, // allow ±1 per user for rounding
        },
        balanceMismatchCount: balanceCheck.mismatchCount,
        balanceMismatches: balanceCheck.mismatches.slice(0, 20),
        totalChecked: balanceCheck.totalChecked,
        negativeBalanceCount,
        unsettledCalls,
        pendingWithdrawals,
        totalWithdrawalsPaid,
        openSupportTickets,
        highPriorityTickets,
        platformStats: {
          totalUsers,
          totalCreators,
          totalTransactions,
          totalCalls,
        },
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('❌ [ADMIN] Full audit report error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
