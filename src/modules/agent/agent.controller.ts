import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { CreatorApplication } from './creator-application.model';
import { Withdrawal } from '../creator/withdrawal.model';
import { assertAgent } from '../../middlewares/staff.middleware';
import { loadStaffUserByAuth } from '../../middlewares/staff.middleware';
import { promoteUserToCreatorWithStarterProfile } from '../creator/creator-starter.service';
import { getIO } from '../../config/socket';
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

function emitCreatorApplicationUpdated(applicantFirebaseUid: string, payload: Record<string, unknown>): void {
  try {
    const io = getIO();
    io.to(`user:${applicantFirebaseUid}`).emit('creator_application:updated', {
      ...payload,
      timestamp: new Date().toISOString(),
    });
  } catch {
    /* optional */
  }
}

export const getAgentDashboardSummary = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAgent(req, res))) return;
    const agent = await loadStaffUserByAuth(req);
    if (!agent) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const [pendingApps, pendingWd, creatorRows] = await Promise.all([
      CreatorApplication.countDocuments({ agentUserId: agent._id, status: 'pending' }),
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
        pendingApplications: pendingApps,
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

export const getPendingApplications = async (req: Request, res: Response): Promise<void> => {
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
      CreatorApplication.find({ agentUserId: agent._id, status: 'pending' })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('applicantUserId', 'email phone username avatar createdAt')
        .lean(),
      CreatorApplication.countDocuments({ agentUserId: agent._id, status: 'pending' }),
    ]);

    res.json({
      success: true,
      data: {
        applications: rows.map((p: any) => ({
          id: p._id.toString(),
          referralCodeUsed: p.referralCodeUsed,
          createdAt: p.createdAt,
          applicant: p.applicantUserId
            ? {
                id: p.applicantUserId._id?.toString(),
                email: p.applicantUserId.email,
                phone: p.applicantUserId.phone,
                username: p.applicantUserId.username,
                avatar: p.applicantUserId.avatar,
                createdAt: p.applicantUserId.createdAt,
              }
            : null,
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    logError('getPendingApplications', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const acceptApplication = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAgent(req, res))) return;
    const agent = await loadStaffUserByAuth(req);
    if (!agent) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const appDoc = await CreatorApplication.findById(id).session(session);
      if (!appDoc || appDoc.status !== 'pending') {
        await session.abortTransaction();
        res.status(404).json({ success: false, error: 'Pending application not found' });
        return;
      }
      if (!appDoc.agentUserId.equals(agent._id)) {
        await session.abortTransaction();
        res.status(403).json({ success: false, error: 'Forbidden' });
        return;
      }

      const applicant = await User.findById(appDoc.applicantUserId).session(session);
      if (!applicant) {
        await session.abortTransaction();
        res.status(404).json({ success: false, error: 'Applicant not found' });
        return;
      }

      const existingCreator = await Creator.findOne({ userId: applicant._id }).session(session);
      if (existingCreator) {
        await session.abortTransaction();
        res.status(409).json({ success: false, error: 'Applicant already has a creator profile' });
        return;
      }

      applicant.$session(session);
      const created = await promoteUserToCreatorWithStarterProfile(applicant, {
        assignedAgentId: agent._id,
        session,
      });

      appDoc.status = 'accepted';
      appDoc.resolvedAt = new Date();
      await appDoc.save({ session });

      await session.commitTransaction();

      logInfo('Agent accepted creator application', {
        applicationId: id,
        agentId: agent._id.toString(),
        creatorId: created._id.toString(),
      });

      emitCreatorApplicationUpdated(applicant.firebaseUid, {
        status: 'accepted',
        creatorId: created._id.toString(),
      });

      await invalidateAdminCaches('creators_performance', 'overview');

      res.json({
        success: true,
        data: {
          applicationId: appDoc._id.toString(),
          creatorId: created._id.toString(),
          userId: applicant._id.toString(),
        },
      });
    } catch (e) {
      await session.abortTransaction();
      throw e;
    } finally {
      session.endSession();
    }
  } catch (error) {
    logError('acceptApplication', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const rejectApplication = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAgent(req, res))) return;
    const agent = await loadStaffUserByAuth(req);
    if (!agent) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    const reason =
      typeof req.body?.rejectionReason === 'string' ? req.body.rejectionReason.trim().slice(0, 2000) : '';

    const appDoc = await CreatorApplication.findById(id);
    if (!appDoc || appDoc.status !== 'pending') {
      res.status(404).json({ success: false, error: 'Pending application not found' });
      return;
    }
    if (!appDoc.agentUserId.equals(agent._id)) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    appDoc.status = 'rejected';
    appDoc.resolvedAt = new Date();
    appDoc.rejectionReason = reason || undefined;
    await appDoc.save();

    const applicant = await User.findById(appDoc.applicantUserId).select('firebaseUid').lean();
    if (applicant) {
      emitCreatorApplicationUpdated(applicant.firebaseUid, {
        status: 'rejected',
        rejectionReason: reason || undefined,
      });
    }

    res.json({ success: true, data: { applicationId: appDoc._id.toString(), status: 'rejected' } });
  } catch (error) {
    logError('rejectApplication', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

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

    const sortKeyRaw = (req.query.sort as string) || 'talkMinutesPeriod';
    const sortKey = sortKeyRaw;
    const dirAsc = (req.query.dir as string) === 'asc';

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const skip = (page - 1) * limit;

    const creators = await Creator.find({ assignedAgentId: agent._id }).lean();
    const total = creators.length;
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

    const userObjectIds = creators.map((c) => c.userId as mongoose.Types.ObjectId);
    const users = await User.find({ _id: { $in: userObjectIds } })
      .select('username email phone coins firebaseUid')
      .lean();
    const userMap = new Map(users.map((u) => [u._id.toString(), u]));

    const [periodStats, allTimeStats, pendingList] = await Promise.all([
      aggregateCallStatsByUser(userObjectIds, periodStart, periodEnd),
      aggregateCallStatsByUser(userObjectIds, null, periodEnd),
      Withdrawal.find({
        creatorUserId: { $in: userObjectIds },
        status: 'pending',
      })
        .select('creatorUserId amount requestedAt _id')
        .lean(),
    ]);

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

    const firebaseUids = users.map((u) => u.firebaseUid).filter(Boolean) as string[];
    const availabilityMap =
      firebaseUids.length > 0 ? await getBatchAvailability(firebaseUids) : {};

    type Enriched = {
      id: string;
      userId: string;
      name: string;
      photo: string;
      categories: string[];
      price: number;
      age?: number;
      earningsCoins: number;
      updatedAt: Date;
      username?: string;
      email?: string;
      phone?: string;
      coins?: number;
      availability: 'online' | 'busy';
      pendingWithdrawal: { id: string; amount: number; requestedAt: string } | null;
      periodTalkMinutes: number;
      periodCoinsEarned: number;
      periodCallCount: number;
      allTimeTalkMinutes: number;
      _sortOnline: number;
      _sortName: string;
      _sortUsername: string;
      _sortUpdated: number;
    };

    const rows: Enriched[] = creators.map((c) => {
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
        _sortOnline: avail === 'online' ? 1 : 0,
        _sortName: (c.name || '').toLowerCase(),
        _sortUsername: (u?.username || '').toLowerCase(),
        _sortUpdated: +new Date(c.updatedAt),
      };
    });

    const cmp = (a: Enriched, b: Enriched): number => {
      let v = 0;
      switch (sortKey) {
        case 'name':
          v = a._sortName.localeCompare(b._sortName);
          break;
        case 'username':
          v = a._sortUsername.localeCompare(b._sortUsername);
          break;
        case 'coins':
          v = (a.coins ?? 0) - (b.coins ?? 0);
          break;
        case 'earningsPeriod':
          v = a.periodCoinsEarned - b.periodCoinsEarned;
          break;
        case 'talkMinutesPeriod':
          v = a.periodTalkMinutes - b.periodTalkMinutes;
          break;
        case 'callsPeriod':
          v = a.periodCallCount - b.periodCallCount;
          break;
        case 'updatedAt':
          v = a._sortUpdated - b._sortUpdated;
          break;
        case 'online':
          v = a._sortOnline - b._sortOnline;
          break;
        case 'earnings':
        case 'earningsCoins':
          v = a.earningsCoins - b.earningsCoins;
          break;
        case 'allTimeTalkMinutes':
          v = a.allTimeTalkMinutes - b.allTimeTalkMinutes;
          break;
        default:
          v = a.periodTalkMinutes - b.periodTalkMinutes;
      }
      if (v !== 0) return dirAsc ? v : -v;
      return a._sortName.localeCompare(b._sortName);
    };

    rows.sort(cmp);

    const pageRows = rows.slice(skip, skip + limit).map(
      ({ _sortOnline, _sortName, _sortUsername, _sortUpdated, ...rest }) => rest,
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

    const { userId, name, about, photo, price, categories, age } = req.body ?? {};

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

    if (typeof price !== 'number' || price < 0) {
      res.status(400).json({ success: false, error: 'Price must be a non-negative number' });
      return;
    }

    if (age !== undefined && (typeof age !== 'number' || age < 18 || age > 100)) {
      res.status(400).json({ success: false, error: 'Age must be a number between 18 and 100' });
      return;
    }

    const targetUser = await User.findById(userId);
    if (!targetUser) {
      res.status(404).json({ success: false, error: 'User not found' });
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
            price,
            age: age !== undefined ? age : undefined,
            assignedAgentId: agent._id,
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

/** Pick users without a creator profile (for manual add). */
export const searchUsersForAgent = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAgent(req, res))) return;

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limit = Math.min(30, Math.max(1, parseInt(req.query.limit as string, 10) || 30));

    const creatorUserIds = await Creator.distinct('userId');
    const excludeIds = creatorUserIds.map((id) => new mongoose.Types.ObjectId(String(id)));

    const filter: Record<string, unknown> = {
      _id: { $nin: excludeIds },
      role: { $nin: ['admin', 'agent'] },
    };

    if (q.length > 0) {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchRegex = new RegExp(escaped, 'i');
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
