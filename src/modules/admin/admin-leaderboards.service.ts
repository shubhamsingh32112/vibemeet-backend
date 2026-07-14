/**
 * Leaderboard aggregations for super-admin (hosts & end-users).
 */
import mongoose from 'mongoose';
import { CallHistory } from '../billing/call-history.model';
import { Creator } from '../creator/creator.model';
import { ChatMessageQuota } from '../chat/chat-message-quota.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { User } from '../user/user.model';
import { buildAvatarUrls } from '../images/image-url';
import type { IImageAsset } from '../images/image-asset.schema';
import { CreatorFollow } from '../moments/models/creator-follow.model';
import { clampDashboardLimit } from './admin-dashboard.service';
import { istLookbackCalendarDays } from '../../utils/ist-time';

export type LeaderboardPeriod = '7d' | '30d' | '90d' | 'all';

export type HostLeaderboardSort =
  | 'calls'
  | 'talk_time'
  | 'earnings'
  | 'gross_spend'
  | 'avg_duration';

export type UserLeaderboardSort =
  | 'calls'
  | 'talk_time'
  | 'messages'
  | 'recharge_inr'
  | 'recharge_coins'
  | 'coins_received'
  | 'coins_spent';

function periodToFrom(period: LeaderboardPeriod): Date | null {
  if (period === 'all') return null;
  const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
  return istLookbackCalendarDays(days).from;
}

function createdAtMatch(from: Date | null): Record<string, unknown> {
  return from ? { createdAt: { $gte: from } } : {};
}

function leaderboardAvatarSmUrl(avatar: IImageAsset | null | undefined): string | null {
  const id = typeof avatar?.imageId === 'string' ? avatar.imageId.trim() : '';
  if (!id) return null;
  try {
    return buildAvatarUrls(id).sm;
  } catch {
    return null;
  }
}

export function parseInrFromPurchaseDescription(desc?: string | null): number {
  if (!desc) return 0;
  const m = desc.match(/₹\s*([\d,]+)/);
  if (!m) return 0;
  return parseInt(m[1].replace(/,/g, ''), 10) || 0;
}

type HostAggRow = {
  userId: string;
  callCount: number;
  talkSeconds: number;
  earningsCoins: number;
  grossSpendCoins: number;
};

async function aggregateHostCallStats(from: Date | null): Promise<Map<string, HostAggRow>> {
  const dateMatch = createdAtMatch(from);
  const [creatorSide, userSide] = await Promise.all([
    CallHistory.aggregate<{
      _id: mongoose.Types.ObjectId;
      callCount: number;
      talkSeconds: number;
      earningsCoins: number;
    }>([
      { $match: { ownerRole: 'creator', ...dateMatch } },
      {
        $group: {
          _id: '$ownerUserId',
          callCount: { $sum: 1 },
          talkSeconds: { $sum: '$durationSeconds' },
          earningsCoins: { $sum: '$coinsEarned' },
        },
      },
    ]),
    CallHistory.aggregate<{
      _id: mongoose.Types.ObjectId;
      grossSpendCoins: number;
    }>([
      {
        $match: {
          ownerRole: 'user',
          otherCreatorId: { $exists: true, $ne: null },
          ...dateMatch,
        },
      },
      {
        $group: {
          _id: '$otherCreatorId',
          grossSpendCoins: { $sum: '$coinsDeducted' },
        },
      },
    ]),
  ]);

  const creatorUserByCreatorId = new Map<string, string>();
  const creatorIds = userSide.map((r) => r._id).filter(Boolean);
  if (creatorIds.length > 0) {
    const creators = await Creator.find({ _id: { $in: creatorIds } })
      .select('_id userId')
      .lean();
    for (const c of creators) {
      if (c.userId) creatorUserByCreatorId.set(c._id.toString(), c.userId.toString());
    }
  }

  const map = new Map<string, HostAggRow>();

  for (const row of creatorSide) {
    const uid = row._id.toString();
    map.set(uid, {
      userId: uid,
      callCount: row.callCount,
      talkSeconds: row.talkSeconds,
      earningsCoins: row.earningsCoins,
      grossSpendCoins: 0,
    });
  }

  for (const row of userSide) {
    const uid = creatorUserByCreatorId.get(row._id.toString());
    if (!uid) continue;
    const existing = map.get(uid);
    if (existing) {
      existing.grossSpendCoins = row.grossSpendCoins;
    } else {
      map.set(uid, {
        userId: uid,
        callCount: 0,
        talkSeconds: 0,
        earningsCoins: 0,
        grossSpendCoins: row.grossSpendCoins,
      });
    }
  }

  return map;
}

function sortHostRows(rows: HostAggRow[], sort: HostLeaderboardSort): HostAggRow[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    switch (sort) {
      case 'calls':
        return b.callCount - a.callCount;
      case 'talk_time':
        return b.talkSeconds - a.talkSeconds;
      case 'earnings':
        return b.earningsCoins - a.earningsCoins;
      case 'gross_spend':
        return b.grossSpendCoins - a.grossSpendCoins;
      case 'avg_duration': {
        const avgA = a.callCount > 0 ? a.talkSeconds / a.callCount : 0;
        const avgB = b.callCount > 0 ? b.talkSeconds / b.callCount : 0;
        return avgB - avgA;
      }
      default:
        return b.earningsCoins - a.earningsCoins;
    }
  });
  return copy;
}

export async function leaderboardHosts(params: {
  period: LeaderboardPeriod;
  sort: HostLeaderboardSort;
  limit: number;
}) {
  const lim = clampDashboardLimit(params.limit, 50);
  const from = periodToFrom(params.period);
  const statsMap = await aggregateHostCallStats(from);
  const sorted = sortHostRows([...statsMap.values()], params.sort).slice(0, lim);

  const userIds = sorted.map((r) => new mongoose.Types.ObjectId(r.userId));
  const creators =
    userIds.length === 0
      ? []
      : await Creator.find({ userId: { $in: userIds } })
          .select('_id name userId avatar earningsCoins assignedAgencyId')
          .lean();

  const creatorByUserId = new Map(creators.map((c) => [c.userId?.toString() ?? '', c]));

  const creatorObjectIds = creators
    .map((c) => c._id)
    .filter((id): id is mongoose.Types.ObjectId => Boolean(id));
  const followerCountByCreatorId = new Map<string, number>();
  if (creatorObjectIds.length > 0) {
    const followerAgg = await CreatorFollow.aggregate<{ _id: mongoose.Types.ObjectId; followerCount: number }>([
      { $match: { creatorId: { $in: creatorObjectIds } } },
      { $group: { _id: '$creatorId', followerCount: { $sum: 1 } } },
    ]);
    for (const row of followerAgg) {
      followerCountByCreatorId.set(row._id.toString(), row.followerCount);
    }
  }

  return {
    period: params.period,
    sort: params.sort,
    rows: sorted.map((row, i) => {
      const c = creatorByUserId.get(row.userId);
      const talkMinutes = Math.round((row.talkSeconds / 60) * 100) / 100;
      const avgDurationSec =
        row.callCount > 0 ? Math.round(row.talkSeconds / row.callCount) : 0;
      return {
        rank: i + 1,
        creatorId: c?._id?.toString() ?? null,
        hostUserId: row.userId,
        hostName: c?.name ?? 'Unknown host',
        avatarUrl: leaderboardAvatarSmUrl(c?.avatar as IImageAsset | null | undefined),
        callCount: row.callCount,
        talkSeconds: row.talkSeconds,
        talkMinutes,
        avgCallDurationSec: avgDurationSec,
        earningsCoins: row.earningsCoins,
        grossSpendCoins: row.grossSpendCoins,
        lifetimeEarningsCoins: c?.earningsCoins ?? 0,
        followerCount: c?._id
          ? followerCountByCreatorId.get(c._id.toString()) ?? 0
          : 0,
      };
    }),
    note:
      'Call and talk-time stats from creator-side call history; gross spend is user coins deducted on calls to this host. Earnings are host coins earned on calls.',
  };
}

type UserAggCore = {
  userId: string;
  callCount: number;
  talkSeconds: number;
  coinsSpentOnCalls: number;
  coinsSpent: number;
  coinsReceived: number;
  rechargeCoins: number;
  rechargeInr: number;
  freeMessages: number;
  paidMessages: number;
};

async function aggregateUserStats(from: Date | null): Promise<Map<string, UserAggCore>> {
  const dateMatch = createdAtMatch(from);
  const endUserIds = await User.distinct('_id', { role: 'user' });
  const coinMatch =
    endUserIds.length > 0
      ? { userId: { $in: endUserIds }, status: 'completed' as const, ...dateMatch }
      : null;

  const [callAgg, coinAgg, chatAgg, rechargeRows] = await Promise.all([
    CallHistory.aggregate<{
      _id: mongoose.Types.ObjectId;
      callCount: number;
      talkSeconds: number;
      coinsSpentOnCalls: number;
    }>([
      { $match: { ownerRole: 'user', ...dateMatch } },
      {
        $group: {
          _id: '$ownerUserId',
          callCount: { $sum: 1 },
          talkSeconds: { $sum: '$durationSeconds' },
          coinsSpentOnCalls: { $sum: '$coinsDeducted' },
        },
      },
    ]),
    coinMatch
      ? CoinTransaction.aggregate<{
          _id: mongoose.Types.ObjectId;
          coinsReceived: number;
          coinsSpent: number;
          rechargeCoins: number;
        }>([
          { $match: coinMatch },
          {
            $group: {
              _id: '$userId',
              coinsReceived: {
                $sum: { $cond: [{ $eq: ['$type', 'credit'] }, '$coins', 0] },
              },
              coinsSpent: {
                $sum: { $cond: [{ $eq: ['$type', 'debit'] }, '$coins', 0] },
              },
              rechargeCoins: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$type', 'credit'] },
                        { $eq: ['$source', 'payment_gateway'] },
                      ],
                    },
                    '$coins',
                    0,
                  ],
                },
              },
            },
          },
        ])
      : Promise.resolve([]),
    ChatMessageQuota.aggregate<{
      _id: string;
      freeMessages: number;
      paidMessages: number;
    }>([
      {
        $group: {
          _id: '$userFirebaseUid',
          freeMessages: { $sum: '$freeMessagesSent' },
          paidMessages: { $sum: '$paidMessagesSent' },
        },
      },
    ]),
    coinMatch
      ? CoinTransaction.find({
          ...coinMatch,
          type: 'credit',
          source: 'payment_gateway',
        })
          .select('userId description coins')
          .lean()
      : Promise.resolve([]),
  ]);

  const map = new Map<string, UserAggCore>();

  const ensure = (userId: string): UserAggCore => {
    let row = map.get(userId);
    if (!row) {
      row = {
        userId,
        callCount: 0,
        talkSeconds: 0,
        coinsSpentOnCalls: 0,
        coinsSpent: 0,
        coinsReceived: 0,
        rechargeCoins: 0,
        rechargeInr: 0,
        freeMessages: 0,
        paidMessages: 0,
      };
      map.set(userId, row);
    }
    return row;
  };

  for (const r of callAgg) {
    const row = ensure(r._id.toString());
    row.callCount = r.callCount;
    row.talkSeconds = r.talkSeconds;
    row.coinsSpentOnCalls = r.coinsSpentOnCalls;
  }

  for (const r of coinAgg) {
    const row = ensure(r._id.toString());
    row.coinsReceived = r.coinsReceived;
    row.coinsSpent = Math.max(row.coinsSpent, r.coinsSpent);
    row.rechargeCoins = r.rechargeCoins;
  }

  const rechargeInrByUser = new Map<string, number>();
  for (const tx of rechargeRows) {
    const uid = tx.userId.toString();
    rechargeInrByUser.set(uid, (rechargeInrByUser.get(uid) ?? 0) + parseInrFromPurchaseDescription(tx.description));
    ensure(uid);
  }
  for (const [uid, inr] of rechargeInrByUser) {
    ensure(uid).rechargeInr = inr;
  }

  const firebaseToUserId = new Map<string, string>();
  const chatFirebaseUids = chatAgg.map((c) => c._id).filter(Boolean);
  if (chatFirebaseUids.length > 0) {
    const users = await User.find({ firebaseUid: { $in: chatFirebaseUids }, role: 'user' })
      .select('_id firebaseUid')
      .lean();
    for (const u of users) {
      firebaseToUserId.set(u.firebaseUid, u._id.toString());
    }
  }

  for (const c of chatAgg) {
    const uid = firebaseToUserId.get(c._id);
    if (!uid) continue;
    const row = ensure(uid);
    row.freeMessages = c.freeMessages;
    row.paidMessages = c.paidMessages;
  }

  return map;
}

function sortUserRows(rows: UserAggCore[], sort: UserLeaderboardSort): UserAggCore[] {
  const totalMessages = (r: UserAggCore) => r.freeMessages + r.paidMessages;
  const copy = [...rows];
  copy.sort((a, b) => {
    switch (sort) {
      case 'calls':
        return b.callCount - a.callCount;
      case 'talk_time':
        return b.talkSeconds - a.talkSeconds;
      case 'messages':
        return totalMessages(b) - totalMessages(a);
      case 'recharge_inr':
        return b.rechargeInr - a.rechargeInr;
      case 'recharge_coins':
        return b.rechargeCoins - a.rechargeCoins;
      case 'coins_received':
        return b.coinsReceived - a.coinsReceived;
      case 'coins_spent':
        return b.coinsSpent - a.coinsSpent;
      default:
        return b.rechargeInr - a.rechargeInr;
    }
  });
  return copy;
}

export async function leaderboardUsers(params: {
  period: LeaderboardPeriod;
  sort: UserLeaderboardSort;
  limit: number;
}) {
  const lim = clampDashboardLimit(params.limit, 50);
  const from = periodToFrom(params.period);
  const endUserIds = await User.distinct('_id', { role: 'user' });
  const statsMap = await aggregateUserStats(from);

  const allowedIds = new Set(endUserIds.map((id) => id.toString()));
  const filtered = [...statsMap.values()].filter((r) => allowedIds.has(r.userId));
  const sorted = sortUserRows(filtered, params.sort).slice(0, lim);

  const ids = sorted.map((r) => new mongoose.Types.ObjectId(r.userId));
  const users =
    ids.length === 0
      ? []
      : await User.find({ _id: { $in: ids }, role: 'user' })
          .select('email phone username displayName avatar coins')
          .lean();
  const userById = new Map(users.map((u) => [u._id.toString(), u]));

  return {
    period: params.period,
    sort: params.sort,
    rows: sorted.map((row, i) => {
      const u = userById.get(row.userId);
      const label =
        (u?.displayName && u.displayName.trim()) ||
        u?.username ||
        u?.email ||
        u?.phone ||
        row.userId;
      const totalMessages = row.freeMessages + row.paidMessages;
      return {
        rank: i + 1,
        userId: row.userId,
        label,
        email: u?.email ?? null,
        phone: u?.phone ?? null,
        avatarUrl: leaderboardAvatarSmUrl(u?.avatar as IImageAsset | null | undefined),
        walletCoins: u?.coins ?? 0,
        callCount: row.callCount,
        talkSeconds: row.talkSeconds,
        talkMinutes: Math.round((row.talkSeconds / 60) * 100) / 100,
        totalMessages,
        freeMessages: row.freeMessages,
        paidMessages: row.paidMessages,
        rechargeCoins: row.rechargeCoins,
        rechargeInr: row.rechargeInr,
        coinsReceived: row.coinsReceived,
        coinsSpent: row.coinsSpent,
        coinsSpentOnCalls: row.coinsSpentOnCalls,
      };
    }),
    note:
      'End-users only (role=user). Messages are lifetime free+paid from chat quota. Recharge INR is parsed from payment descriptions (₹ in ledger). Coins spent is all completed debits; coins spent on calls is call deductions only.',
  };
}

export function parseLeaderboardPeriod(raw: unknown): LeaderboardPeriod {
  const v = String(raw ?? '30d');
  if (v === '7d' || v === '30d' || v === '90d' || v === 'all') return v;
  return '30d';
}

export function parseHostSort(raw: unknown): HostLeaderboardSort {
  const v = String(raw ?? 'earnings');
  const allowed: HostLeaderboardSort[] = [
    'calls',
    'talk_time',
    'earnings',
    'gross_spend',
    'avg_duration',
  ];
  return allowed.includes(v as HostLeaderboardSort) ? (v as HostLeaderboardSort) : 'earnings';
}

export function parseUserSort(raw: unknown): UserLeaderboardSort {
  const v = String(raw ?? 'recharge_inr');
  const allowed: UserLeaderboardSort[] = [
    'calls',
    'talk_time',
    'messages',
    'recharge_inr',
    'recharge_coins',
    'coins_received',
    'coins_spent',
  ];
  return allowed.includes(v as UserLeaderboardSort) ? (v as UserLeaderboardSort) : 'recharge_inr';
}
