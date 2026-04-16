import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { ReferralEdge } from '../user/referral-edge.model';
import { Withdrawal } from '../creator/withdrawal.model';
import { assertAgent } from '../../middlewares/staff.middleware';
import { loadStaffUserByAuth } from '../../middlewares/staff.middleware';
import {
  processWithdrawalApproval,
  processWithdrawalRejection,
  processWithdrawalMarkPaid,
} from '../creator/withdrawal-processing.service';
import { invalidateAdminCaches } from '../../config/redis';
import { CallHistory } from '../billing/call-history.model';
import { logError, logInfo } from '../../utils/logger';
import { getBatchAvailability } from '../availability/availability.service';
import { resolveGalleryImageUrlsForApi } from '../creator/creator-gallery-resolve';
import { notifyCreatorProfileChannels } from '../creator/creator.controller';
import { getCachedCreatorUserObjectIds } from './creator-user-ids-cache';
import { buildSafeMongoSubstringRegex } from '../../utils/mongo-regex';
import { validateCreatorPriceForApi } from '../../config/creator-price.config';
import { parseCreatorLocationForCreate } from '../creator/creator-location.util';
import { ensureCreatorPromotionBonusReversalEntry } from '../creator/creator-starter.service';

function sinceDaysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

async function earningsInWindow(userMongoId: mongoose.Types.ObjectId, since: Date): Promise<number> {
  const agg = await CallHistory.aggregate([
    {
      $match: {
        ownerUserId: userMongoId,
        ownerRole: 'creator',
        durationSeconds: { $gt: 0 },
        createdAt: { $gte: since },
      },
    },
    { $group: { _id: null, total: { $sum: '$coinsEarned' } } },
  ]);
  return agg[0]?.total ?? 0;
}

/** Local calendar day 00:00 → now (agent dashboard "today"). */
function startOfLocalToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Rolling windows for 7d/30d; `today` = calendar day; `all` = no start bound. */
function agentPeriodBounds(period: string): { start: Date | null; end: Date } {
  const now = new Date();
  if (period === 'all') return { start: null, end: now };
  if (period === '7d') return { start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), end: now };
  if (period === '30d') return { start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), end: now };
  return { start: startOfLocalToday(), end: now };
}

type CallAggRow = { talkSeconds: number; periodCoinsEarned: number; callCount: number };

async function aggregateCallStatsByUser(
  userObjectIds: mongoose.Types.ObjectId[],
  start: Date | null,
  end: Date,
): Promise<Map<string, CallAggRow>> {
  if (userObjectIds.length === 0) return new Map();
  const match: Record<string, unknown> = {
    ownerUserId: { $in: userObjectIds },
    ownerRole: 'creator',
    durationSeconds: { $gt: 0 },
  };
  if (start) {
    match.createdAt = { $gte: start, $lte: end };
  }

  const rows = await CallHistory.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$ownerUserId',
        talkSeconds: { $sum: '$durationSeconds' },
        periodCoinsEarned: { $sum: '$coinsEarned' },
        callCount: { $sum: 1 },
      },
    },
  ]);
  const m = new Map<string, CallAggRow>();
  for (const r of rows) {
    m.set(String(r._id), {
      talkSeconds: r.talkSeconds ?? 0,
      periodCoinsEarned: r.periodCoinsEarned ?? 0,
      callCount: r.callCount ?? 0,
    });
  }
  return m;
}

/** Users referred by this agent who do not yet have a Creator profile. */
async function countReferredUsersAwaitingPromotion(
  agentId: mongoose.Types.ObjectId
): Promise<number> {
  const agg = await User.aggregate<{ n?: number }>([
    { $match: { referredBy: agentId } },
    { $lookup: { from: 'creators', localField: '_id', foreignField: 'userId', as: 'cr' } },
    { $match: { $expr: { $eq: [{ $size: '$cr' }, 0] } } },
    { $count: 'n' },
  ]);
  return agg[0]?.n ?? 0;
}

export const getAgentDashboardSummary = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAgent(req, res))) return;
    const agent = await loadStaffUserByAuth(req);
    if (!agent) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const [referredUsersAwaitingPromotion, pendingWd, creatorRows] = await Promise.all([
      countReferredUsersAwaitingPromotion(agent._id),
      Withdrawal.countDocuments({ assignedAgentId: agent._id, status: 'pending' }),
      Creator.find({ assignedAgentId: agent._id }).select('userId').lean(),
    ]);

    const userIdsForOnline = [...new Set(creatorRows.map((c) => c.userId.toString()))].map(
      (id) => new mongoose.Types.ObjectId(id),
    );
    const usersForOnline =
      userIdsForOnline.length > 0
        ? await User.find({ _id: { $in: userIdsForOnline } }).select('firebaseUid').lean()
        : [];
    const firebaseUids = usersForOnline.map((u) => u.firebaseUid).filter(Boolean) as string[];
    const availabilityMap =
      firebaseUids.length > 0 ? await getBatchAvailability(firebaseUids) : {};
    let onlineCreators = 0;
    for (const uid of firebaseUids) {
      if (availabilityMap[uid] === 'online') onlineCreators += 1;
    }

    const totalCreators = creatorRows.length;

    res.json({
      success: true,
      data: {
        referredUsersAwaitingPromotion,
        /** @deprecated Use referredUsersAwaitingPromotion — same value, kept for older clients */
        pendingApplications: referredUsersAwaitingPromotion,
        pendingWithdrawals: pendingWd,
        activeCreators: totalCreators,
        totalCreators,
        onlineCreators,
      },
    });
  } catch (error) {
    logError('getAgentDashboardSummary', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/** Paginated users who signed up with this agent's referral (User.referredBy). */
export const getAgentReferredUsers = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAgent(req, res))) return;
    const agent = await loadStaffUserByAuth(req);
    if (!agent) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      User.find({ referredBy: agent._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('username email phone avatar role createdAt')
        .lean(),
      User.countDocuments({ referredBy: agent._id }),
    ]);

    const userIds = rows.map((u) => u._id);
    const [edges, creators] = await Promise.all([
      ReferralEdge.find({ referredUserId: { $in: userIds } })
        .select('referredUserId referralCodeUsed')
        .lean(),
      Creator.find({ userId: { $in: userIds } }).select('_id userId').lean(),
    ]);
    const edgeMap = new Map(edges.map((e) => [e.referredUserId.toString(), e.referralCodeUsed]));
    const creatorByUser = new Map(creators.map((c) => [c.userId.toString(), c._id.toString()]));

    const agentCode = agent.referralCode?.toUpperCase() ?? null;

    res.json({
      success: true,
      data: {
        users: rows.map((u) => {
          const id = u._id.toString();
          return {
            id,
            username: u.username,
            email: u.email,
            phone: u.phone,
            avatar: u.avatar,
            role: u.role,
            createdAt: u.createdAt,
            referralCodeUsed: edgeMap.get(id) ?? agentCode,
            hasCreator: creatorByUser.has(id),
            creatorId: creatorByUser.get(id) ?? null,
          };
        }),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    logError('getAgentReferredUsers', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

const DB_PAGINATED_AGENT_CREATOR_SORTS = new Set<string>([
  'talkMinutesPeriod',
  'earningsPeriod',
  'callsPeriod',
  'allTimeTalkMinutes',
  'name',
  'username',
  'coins',
  'earningsCoins',
  'earnings',
  'updatedAt',
]);

function normalizeAgentCreatorSortKey(raw: string): string {
  if (DB_PAGINATED_AGENT_CREATOR_SORTS.has(raw)) return raw;
  return 'talkMinutesPeriod';
}

function buildAgentCreatorSortSpec(sortKey: string, dirAsc: boolean): Record<string, 1 | -1> {
  const d = dirAsc ? 1 : -1;
  switch (sortKey) {
    case 'name':
      return { nameLower: d, _id: 1 };
    case 'username':
      return { usernameLower: d, _id: 1 };
    case 'coins':
      return { userCoins: d, _id: 1 };
    case 'earningsCoins':
    case 'earnings':
      return { earningsCoins: d, _id: 1 };
    case 'updatedAt':
      return { updatedAt: d, _id: 1 };
    case 'earningsPeriod':
      return { periodCoinsEarned: d, _id: 1 };
    case 'callsPeriod':
      return { periodCallCount: d, _id: 1 };
    case 'talkMinutesPeriod':
      return { periodTalkSeconds: d, _id: 1 };
    case 'allTimeTalkMinutes':
      return { allTimeTalkSeconds: d, _id: 1 };
    default:
      return { periodTalkSeconds: d, _id: 1 };
  }
}

type CreatorAggRow = {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  name: string;
  photo: string;
  categories: string[];
  price: number;
  age?: number;
  earningsCoins: number;
  updatedAt: Date;
  u?: {
    username?: string;
    email?: string;
    phone?: string;
    coins?: number;
    firebaseUid?: string;
  };
  periodTalkSeconds: number;
  periodCoinsEarned: number;
  periodCallCount: number;
  allTimeTalkSeconds: number;
};

function buildCreatorMetricsStages(
  agentId: mongoose.Types.ObjectId,
  periodStart: Date | null,
  periodEnd: Date,
): mongoose.PipelineStage[] {
  const userColl = User.collection.collectionName;
  const callColl = CallHistory.collection.collectionName;

  const periodExpr: Record<string, unknown> = {
    $expr: {
      $and: [
        { $eq: ['$ownerUserId', '$$uid'] },
        { $eq: ['$ownerRole', 'creator'] },
        { $gt: ['$durationSeconds', 0] },
        ...(periodStart
          ? [
              { $gte: ['$createdAt', periodStart] },
              { $lte: ['$createdAt', periodEnd] },
            ]
          : []),
      ],
    },
  };

  const allTimeExpr: Record<string, unknown> = {
    $expr: {
      $and: [
        { $eq: ['$ownerUserId', '$$uid'] },
        { $eq: ['$ownerRole', 'creator'] },
        { $gt: ['$durationSeconds', 0] },
      ],
    },
  };

  return [
    { $match: { assignedAgentId: agentId } },
    {
      $lookup: {
        from: userColl,
        let: { uid: '$userId' },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', '$$uid'] } } },
          { $project: { username: 1, email: 1, phone: 1, coins: 1, firebaseUid: 1 } },
        ],
        as: 'userArr',
      },
    },
    { $addFields: { u: { $arrayElemAt: ['$userArr', 0] } } },
    { $project: { userArr: 0 } },
    {
      $lookup: {
        from: callColl,
        let: { uid: '$userId' },
        pipeline: [
          { $match: periodExpr },
          {
            $group: {
              _id: null,
              talkSeconds: { $sum: '$durationSeconds' },
              periodCoinsEarned: { $sum: '$coinsEarned' },
              callCount: { $sum: 1 },
            },
          },
        ],
        as: 'periodAgg',
      },
    },
    {
      $lookup: {
        from: callColl,
        let: { uid: '$userId' },
        pipeline: [
          { $match: allTimeExpr },
          { $group: { _id: null, talkSeconds: { $sum: '$durationSeconds' } } },
        ],
        as: 'allTimeAgg',
      },
    },
    {
      $addFields: {
        periodTalkSeconds: {
          $let: {
            vars: { row: { $arrayElemAt: ['$periodAgg', 0] } },
            in: { $ifNull: ['$$row.talkSeconds', 0] },
          },
        },
        periodCoinsEarned: {
          $let: {
            vars: { row: { $arrayElemAt: ['$periodAgg', 0] } },
            in: { $ifNull: ['$$row.periodCoinsEarned', 0] },
          },
        },
        periodCallCount: {
          $let: {
            vars: { row: { $arrayElemAt: ['$periodAgg', 0] } },
            in: { $ifNull: ['$$row.callCount', 0] },
          },
        },
        allTimeTalkSeconds: {
          $let: {
            vars: { row: { $arrayElemAt: ['$allTimeAgg', 0] } },
            in: { $ifNull: ['$$row.talkSeconds', 0] },
          },
        },
        nameLower: { $toLower: { $ifNull: ['$name', ''] } },
        usernameLower: { $toLower: { $ifNull: ['$u.username', ''] } },
        userCoins: { $ifNull: ['$u.coins', 0] },
      },
    },
    { $project: { periodAgg: 0, allTimeAgg: 0 } },
  ];
}

function buildPendingWithdrawalMap(
  pendingList: {
    creatorUserId?: mongoose.Types.ObjectId;
    _id: mongoose.Types.ObjectId;
    amount: number;
    requestedAt: Date;
  }[],
): Map<string, { id: string; amount: number; requestedAt: Date }> {
  const pendingByUserId = new Map<string, { id: string; amount: number; requestedAt: Date }>();
  for (const w of pendingList) {
    const uid = w.creatorUserId?.toString();
    if (uid && !pendingByUserId.has(uid)) {
      pendingByUserId.set(uid, {
        id: w._id.toString(),
        amount: w.amount,
        requestedAt: w.requestedAt,
      });
    }
  }
  return pendingByUserId;
}

function mapAggDocToAgentCreatorJson(
  c: CreatorAggRow,
  availabilityMap: Record<string, string>,
  pendingByUserId: Map<string, { id: string; amount: number; requestedAt: Date }>,
) {
  const uid = c.userId.toString();
  const u = c.u;
  const fUid = u?.firebaseUid || '';
  const avail = (fUid && availabilityMap[fUid] === 'online' ? 'online' : 'busy') as
    | 'online'
    | 'busy';
  const pw = pendingByUserId.get(uid);
  const pts = c.periodTalkSeconds;
  const ats = c.allTimeTalkSeconds;
  return {
    id: c._id.toString(),
    userId: uid,
    name: c.name,
    photo: c.photo,
    categories: c.categories,
    price: c.price,
    age: c.age,
    earningsCoins: c.earningsCoins,
    updatedAt: c.updatedAt,
    username: u?.username,
    email: u?.email,
    phone: u?.phone,
    coins: u?.coins,
    availability: avail,
    pendingWithdrawal: pw
      ? { id: pw.id, amount: pw.amount, requestedAt: pw.requestedAt.toISOString() }
      : null,
    periodTalkMinutes: Math.round((pts / 60) * 100) / 100,
    periodCoinsEarned: c.periodCoinsEarned,
    periodCallCount: c.periodCallCount,
    allTimeTalkMinutes: Math.round((ats / 60) * 100) / 100,
  };
}

export const getAgentCreators = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAgent(req, res))) return;
    const agent = await loadStaffUserByAuth(req);
    if (!agent) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const periodRaw = (req.query.period as string) || 'today';
    const period = ['today', '7d', '30d', 'all'].includes(periodRaw) ? periodRaw : 'today';
    const { start: periodStart, end: periodEnd } = agentPeriodBounds(period);

    const sortKeyRaw = ((req.query.sort as string) || 'talkMinutesPeriod').trim();
    const sortKey =
      sortKeyRaw === 'online' ? 'online' : normalizeAgentCreatorSortKey(sortKeyRaw);
    const dirAsc = (req.query.dir as string) === 'asc';

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const skip = (page - 1) * limit;

    const total = await Creator.countDocuments({ assignedAgentId: agent._id });
    if (total === 0) {
      res.json({
        success: true,
        data: {
          creators: [],
          meta: { period },
          pagination: { page, limit, total: 0, totalPages: 0 },
        },
      });
      return;
    }

    if (sortKey === 'online') {
      const minimal = await Creator.find({ assignedAgentId: agent._id }).select('_id userId').lean();
      const userObjectIds = minimal.map((c) => c.userId as mongoose.Types.ObjectId);
      const users = await User.find({ _id: { $in: userObjectIds } })
        .select('_id firebaseUid')
        .lean();
      const firebaseByUser = new Map(users.map((u) => [u._id.toString(), u.firebaseUid || '']));
      const firebaseUids = users.map((u) => u.firebaseUid).filter(Boolean) as string[];
      const availabilityMap =
        firebaseUids.length > 0 ? await getBatchAvailability(firebaseUids) : {};

      type MRow = {
        creatorId: mongoose.Types.ObjectId;
        userId: string;
        onlineRank: number;
        tie: string;
      };
      const rows: MRow[] = minimal.map((c) => {
        const uid = c.userId.toString();
        const f = firebaseByUser.get(uid) || '';
        const onlineRank = f && availabilityMap[f] === 'online' ? 1 : 0;
        return { creatorId: c._id, userId: uid, onlineRank, tie: uid };
      });
      rows.sort((a, b) => {
        const v = a.onlineRank - b.onlineRank;
        if (v !== 0) return dirAsc ? v : -v;
        return a.tie.localeCompare(b.tie);
      });

      const sliced = rows.slice(skip, skip + limit);
      const pageCreatorIds = sliced.map((r) => r.creatorId);
      const pageUserIds = sliced.map((r) => new mongoose.Types.ObjectId(r.userId));

      const [creators, fullUsers, periodStats, allTimeStats, pendingList] = await Promise.all([
        Creator.find({ _id: { $in: pageCreatorIds } }).lean(),
        User.find({ _id: { $in: pageUserIds } })
          .select('username email phone coins firebaseUid')
          .lean(),
        aggregateCallStatsByUser(pageUserIds, periodStart, periodEnd),
        aggregateCallStatsByUser(pageUserIds, null, periodEnd),
        Withdrawal.find({
          creatorUserId: { $in: pageUserIds },
          status: 'pending',
        })
          .select('creatorUserId amount requestedAt _id')
          .lean(),
      ]);

      const order = new Map(pageCreatorIds.map((id, i) => [id.toString(), i]));
      creators.sort(
        (a, b) => (order.get(a._id.toString()) ?? 0) - (order.get(b._id.toString()) ?? 0),
      );
      const userMap = new Map(fullUsers.map((u) => [u._id.toString(), u]));
      const pendingByUserId = buildPendingWithdrawalMap(pendingList);

      const pageRows = creators.map((c) => {
        const uid = c.userId.toString();
        const u = userMap.get(uid);
        const fUid = u?.firebaseUid || '';
        const avail = (fUid && availabilityMap[fUid] === 'online' ? 'online' : 'busy') as
          | 'online'
          | 'busy';
        const p = periodStats.get(uid) ?? {
          talkSeconds: 0,
          periodCoinsEarned: 0,
          callCount: 0,
        };
        const a = allTimeStats.get(uid) ?? {
          talkSeconds: 0,
          periodCoinsEarned: 0,
          callCount: 0,
        };
        const pw = pendingByUserId.get(uid);
        return {
          id: c._id.toString(),
          userId: uid,
          name: c.name,
          photo: c.photo,
          categories: c.categories,
          price: c.price,
          age: c.age,
          earningsCoins: c.earningsCoins,
          updatedAt: c.updatedAt,
          username: u?.username,
          email: u?.email,
          phone: u?.phone,
          coins: u?.coins,
          availability: avail,
          pendingWithdrawal: pw
            ? { id: pw.id, amount: pw.amount, requestedAt: pw.requestedAt.toISOString() }
            : null,
          periodTalkMinutes: Math.round((p.talkSeconds / 60) * 100) / 100,
          periodCoinsEarned: p.periodCoinsEarned,
          periodCallCount: p.callCount,
          allTimeTalkMinutes: Math.round((a.talkSeconds / 60) * 100) / 100,
        };
      });

      res.json({
        success: true,
        data: {
          creators: pageRows,
          meta: { period },
          pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        },
      });
      return;
    }

    const pipeline: mongoose.PipelineStage[] = [
      ...buildCreatorMetricsStages(agent._id, periodStart, periodEnd),
      { $sort: buildAgentCreatorSortSpec(sortKey, dirAsc) },
      { $skip: skip },
      { $limit: limit },
    ];

    const pageDocs = (await Creator.aggregate(pipeline)) as CreatorAggRow[];

    const pageUserIds = pageDocs.map((d) => d.userId as mongoose.Types.ObjectId);
    const firebaseUids = pageDocs.map((d) => d.u?.firebaseUid).filter(Boolean) as string[];
    const availabilityMap =
      firebaseUids.length > 0 ? await getBatchAvailability(firebaseUids) : {};

    const pendingList =
      pageUserIds.length > 0
        ? await Withdrawal.find({
            creatorUserId: { $in: pageUserIds },
            status: 'pending',
          })
            .select('creatorUserId amount requestedAt _id')
            .lean()
        : [];

    const pendingByUserId = buildPendingWithdrawalMap(pendingList);

    const pageRows = pageDocs.map((doc) =>
      mapAggDocToAgentCreatorJson(doc, availabilityMap, pendingByUserId),
    );

    res.json({
      success: true,
      data: {
        creators: pageRows,
        meta: { period },
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    logError('getAgentCreators', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getAgentCreatorDetail = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAgent(req, res))) return;
    const agent = await loadStaffUserByAuth(req);
    if (!agent) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const periodRaw = (req.query.period as string) || 'today';
    const period = ['today', '7d', '30d', 'all'].includes(periodRaw) ? periodRaw : 'today';
    const { start: periodStart, end: periodEnd } = agentPeriodBounds(period);

    const { creatorId } = req.params;
    const creatorDoc = await Creator.findById(creatorId);
    if (!creatorDoc || !creatorDoc.assignedAgentId?.equals(agent._id)) {
      res.status(404).json({ success: false, error: 'Creator not found' });
      return;
    }

    const { galleryImages, urlsChanged } = await resolveGalleryImageUrlsForApi(creatorDoc.galleryImages);
    if (urlsChanged) {
      await Creator.updateOne({ _id: creatorDoc._id }, { $set: { galleryImages } });
    }

    const creator = creatorDoc.toObject();
    creator.galleryImages = galleryImages;

    const user = await User.findById(creator.userId).lean();
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const uid = user._id;
    const [e1d, e7d, e30d, periodMap, allTimeMap, pendingWd] = await Promise.all([
      earningsInWindow(uid, sinceDaysAgo(1)),
      earningsInWindow(uid, sinceDaysAgo(7)),
      earningsInWindow(uid, sinceDaysAgo(30)),
      aggregateCallStatsByUser([uid], periodStart, periodEnd),
      aggregateCallStatsByUser([uid], null, periodEnd),
      Withdrawal.findOne({ creatorUserId: uid, status: 'pending' })
        .select('_id amount requestedAt')
        .lean(),
    ]);

    const p = periodMap.get(uid.toString()) ?? {
      talkSeconds: 0,
      periodCoinsEarned: 0,
      callCount: 0,
    };
    const a = allTimeMap.get(uid.toString()) ?? {
      talkSeconds: 0,
      periodCoinsEarned: 0,
      callCount: 0,
    };

    const fUid = user.firebaseUid || '';
    const availabilityMap = fUid ? await getBatchAvailability([fUid]) : {};
    const availability = fUid && availabilityMap[fUid] === 'online' ? 'online' : 'busy';

    res.json({
      success: true,
      data: {
        meta: { period },
        creator: {
          id: creator._id.toString(),
          userId: creator.userId.toString(),
          name: creator.name,
          about: creator.about,
          photo: creator.photo,
          galleryImages,
          categories: creator.categories,
          price: creator.price,
          age: creator.age,
          location: creator.location,
          earningsCoins: creator.earningsCoins,
          isOnline: creator.isOnline,
          createdAt: creator.createdAt,
          updatedAt: creator.updatedAt,
        },
        user: {
          id: user._id.toString(),
          username: user.username,
          email: user.email,
          phone: user.phone,
          coins: user.coins,
          avatar: user.avatar,
          profileRevision: user.profileRevision,
        },
        availability,
        earningsSummaryCoins: { last1d: e1d, last7d: e7d, last30d: e30d },
        callStats: {
          periodTalkMinutes: Math.round((p.talkSeconds / 60) * 100) / 100,
          periodCoinsEarned: p.periodCoinsEarned,
          periodCallCount: p.callCount,
          allTimeTalkMinutes: Math.round((a.talkSeconds / 60) * 100) / 100,
          allTimeCoinsEarned: a.periodCoinsEarned,
          allTimeCallCount: a.callCount,
        },
        pendingWithdrawal: pendingWd
          ? {
              id: pendingWd._id.toString(),
              amount: pendingWd.amount,
              requestedAt: pendingWd.requestedAt.toISOString(),
            }
          : null,
      },
    });
  } catch (error) {
    logError('getAgentCreatorDetail', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/** Manual add creator — same economics as admin promote (coins cleared); assigns to calling agent. */
export const postAgentCreateCreator = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAgent(req, res))) return;
    const agent = await loadStaffUserByAuth(req);
    if (!agent) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { userId, name, about, photo, price, categories, age, location } = req.body ?? {};

    if (!name || !about || !photo || !userId || price === undefined) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: name, about, photo, userId, price',
      });
      return;
    }

    if (
      categories !== undefined &&
      (!Array.isArray(categories) || categories.some((c: unknown) => typeof c !== 'string'))
    ) {
      res.status(400).json({ success: false, error: 'Categories must be an array of strings' });
      return;
    }

    const priceCheck = validateCreatorPriceForApi(price);
    if (!priceCheck.ok) {
      res.status(400).json({ success: false, error: priceCheck.error });
      return;
    }
    const validatedPrice = priceCheck.price;

    if (age !== undefined && (typeof age !== 'number' || age < 18 || age > 100)) {
      res.status(400).json({ success: false, error: 'Age must be a number between 18 and 100' });
      return;
    }

    const locCreate = parseCreatorLocationForCreate(location);
    if (!locCreate.ok) {
      res.status(400).json({ success: false, error: locCreate.error });
      return;
    }

    const targetUser = await User.findById(userId);
    if (!targetUser) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    if (!targetUser.referredBy?.equals(agent._id)) {
      res.status(403).json({ success: false, error: 'User was not referred by this agent' });
      return;
    }

    if (targetUser.role === 'admin' || targetUser.role === 'agent') {
      res.status(400).json({ success: false, error: 'Invalid user for creator profile' });
      return;
    }

    const existingCreator = await Creator.findOne({ userId: targetUser._id });
    if (existingCreator) {
      res.status(409).json({ success: false, error: 'Creator profile already exists for this user' });
      return;
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const previousCoins = targetUser.coins || 0;
      targetUser.welcomeBonusClaimed = true;
      targetUser.coins = 0;
      if (targetUser.role !== 'creator') {
        targetUser.role = 'creator';
      }
      await targetUser.save({ session });
      await ensureCreatorPromotionBonusReversalEntry(targetUser, session);

      if (previousCoins > 0) {
        logInfo('Agent manual creator: cleared coins', {
          userId: targetUser._id.toString(),
          previousCoins,
        });
      }

      const createdArr = await Creator.create(
        [
          {
            name,
            about,
            photo: typeof photo === 'string' ? photo.trim() : String(photo),
            galleryImages: [],
            userId: targetUser._id,
            categories: Array.isArray(categories) ? categories : [],
            price: validatedPrice,
            age: age !== undefined ? age : undefined,
            assignedAgentId: agent._id,
            ...(locCreate.value !== undefined ? { location: locCreate.value } : {}),
          },
        ],
        { session },
      );

      const createdCreator = createdArr[0];
      await session.commitTransaction();

      if (targetUser.firebaseUid) {
        await notifyCreatorProfileChannels(targetUser._id, targetUser.firebaseUid);
      }
      await invalidateAdminCaches('overview', 'creators_performance', 'users_analytics');

      logInfo('Agent created creator manually', {
        agentId: agent._id.toString(),
        creatorId: createdCreator._id.toString(),
        userId: targetUser._id.toString(),
      });

      res.status(201).json({
        success: true,
        data: {
          creator: {
            id: createdCreator._id.toString(),
            userId: createdCreator.userId.toString(),
            name: createdCreator.name,
            about: createdCreator.about,
            photo: createdCreator.photo,
            categories: createdCreator.categories,
            price: createdCreator.price,
            age: createdCreator.age,
            location: createdCreator.location,
            createdAt: createdCreator.createdAt,
            updatedAt: createdCreator.updatedAt,
          },
        },
      });
    } catch (e) {
      await session.abortTransaction();
      throw e;
    } finally {
      session.endSession();
    }
  } catch (error) {
    logError('postAgentCreateCreator', error as Error);
    if (error instanceof Error && error.name === 'ValidationError') {
      res.status(400).json({ success: false, error: error.message });
      return;
    }
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/** Pick referred users without a creator profile (for manual add). */
export const searchUsersForAgent = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAgent(req, res))) return;
    const agent = await loadStaffUserByAuth(req);
    if (!agent) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limit = Math.min(30, Math.max(1, parseInt(req.query.limit as string, 10) || 30));

    const excludeIds = await getCachedCreatorUserObjectIds();

    const filter: Record<string, unknown> = {
      _id: { $nin: excludeIds },
      role: { $nin: ['admin', 'agent'] },
      referredBy: agent._id,
    };

    if (q.length > 0) {
      const searchRegex = buildSafeMongoSubstringRegex(q);
      filter.$or = [{ username: searchRegex }, { email: searchRegex }, { phone: searchRegex }];
    }

    const users = await User.find(filter)
      .select('username email phone role avatar createdAt')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({
      success: true,
      data: {
        users: users.map((u) => ({
          id: u._id.toString(),
          username: u.username,
          email: u.email,
          phone: u.phone,
          role: u.role,
          avatar: u.avatar,
          createdAt: u.createdAt,
          isCreator: false,
        })),
      },
    });
  } catch (error) {
    logError('searchUsersForAgent', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getAgentWithdrawals = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAgent(req, res))) return;
    const agent = await loadStaffUserByAuth(req);
    if (!agent) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const statusFilter = req.query.status as string | undefined;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = { assignedAgentId: agent._id };
    if (statusFilter && ['pending', 'approved', 'rejected', 'paid'].includes(statusFilter)) {
      filter.status = statusFilter;
    }

    const [withdrawals, total] = await Promise.all([
      Withdrawal.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Withdrawal.countDocuments(filter),
    ]);

    const enriched = await Promise.all(
      withdrawals.map(async (w) => {
        const u = w.creatorUserId
          ? await User.findById(w.creatorUserId).select('username email phone').lean()
          : null;
        const c = w.creatorUserId
          ? await Creator.findOne({ userId: w.creatorUserId }).select('name photo').lean()
          : null;
        return {
          id: w._id.toString(),
          creatorUserId: w.creatorUserId?.toString() || '',
          creatorName: c?.name || u?.username || 'Unknown',
          creatorEmail: u?.email || null,
          amount: w.amount,
          status: w.status,
          requestedAt: w.requestedAt,
          processedAt: w.processedAt || null,
          notes: w.notes || null,
          name: w.name || null,
          number: w.number || null,
          upi: w.upi || null,
          accountNumber: w.accountNumber || null,
          ifsc: w.ifsc || null,
          createdAt: w.createdAt,
        };
      }),
    );

    res.json({
      success: true,
      data: {
        withdrawals: enriched,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    logError('getAgentWithdrawals', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const agentApproveWithdrawal = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAgent(req, res))) return;
    const agent = await loadStaffUserByAuth(req);
    if (!agent) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const { id } = req.params;
    const notes = typeof req.body?.notes === 'string' ? req.body.notes : undefined;
    const result = await processWithdrawalApproval(id, agent, { notes, isAdmin: false });
    if (!result.ok) {
      res.status(result.status).json({ success: false, error: result.error });
      return;
    }
    res.json({ success: true, data: result.data });
  } catch (error) {
    logError('agentApproveWithdrawal', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const agentRejectWithdrawal = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAgent(req, res))) return;
    const agent = await loadStaffUserByAuth(req);
    if (!agent) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const { id } = req.params;
    const notes = typeof req.body?.notes === 'string' ? req.body.notes : '';
    const result = await processWithdrawalRejection(id, agent, { notes, isAdmin: false });
    if (!result.ok) {
      res.status(result.status).json({ success: false, error: result.error });
      return;
    }
    res.json({ success: true, data: result.data });
  } catch (error) {
    logError('agentRejectWithdrawal', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const agentMarkWithdrawalPaid = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAgent(req, res))) return;
    const agent = await loadStaffUserByAuth(req);
    if (!agent) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const { id } = req.params;
    const notes = typeof req.body?.notes === 'string' ? req.body.notes : undefined;
    const result = await processWithdrawalMarkPaid(id, agent, { notes, isAdmin: false });
    if (!result.ok) {
      res.status(result.status).json({ success: false, error: result.error });
      return;
    }
    res.json({ success: true, data: result.data });
  } catch (error) {
    logError('agentMarkWithdrawalPaid', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
