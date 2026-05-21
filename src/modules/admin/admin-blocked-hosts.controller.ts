import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { SupportTicket } from '../support/support.model';
import { assertAdmin } from '../../middlewares/staff.middleware';
import { logError } from '../../utils/logger';

type HostAccumulator = {
  creatorId: string;
  blockCount: number;
  reportCount: number;
  lastReportedAt: Date | null;
  blockedBySample: Array<{ userId: string; label: string }>;
};

export const getBlockedHosts = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const sort = String(req.query.sort ?? 'blocks_desc');

    const byCreator = new Map<string, HostAccumulator>();

    const bump = (
      creatorId: string,
      patch: {
        blockCount?: number;
        reportCount?: number;
        lastReportedAt?: Date;
        blockedBy?: { userId: string; label: string };
      }
    ) => {
      const existing = byCreator.get(creatorId) ?? {
        creatorId,
        blockCount: 0,
        reportCount: 0,
        lastReportedAt: null,
        blockedBySample: [],
      };
      if (patch.blockCount) existing.blockCount += patch.blockCount;
      if (patch.reportCount) existing.reportCount += patch.reportCount;
      if (patch.lastReportedAt) {
        if (!existing.lastReportedAt || patch.lastReportedAt > existing.lastReportedAt) {
          existing.lastReportedAt = patch.lastReportedAt;
        }
      }
      if (patch.blockedBy && existing.blockedBySample.length < 5) {
        const dup = existing.blockedBySample.some((b) => b.userId === patch.blockedBy!.userId);
        if (!dup) existing.blockedBySample.push(patch.blockedBy);
      }
      byCreator.set(creatorId, existing);
    };

    const blockAgg = await User.aggregate<{
      _id: mongoose.Types.ObjectId;
      blockCount: number;
      users: Array<{ _id: mongoose.Types.ObjectId; email?: string; username?: string }>;
    }>([
      { $match: { role: 'user', blockedCreatorIds: { $exists: true, $not: { $size: 0 } } } },
      { $unwind: '$blockedCreatorIds' },
      {
        $group: {
          _id: '$blockedCreatorIds',
          blockCount: { $sum: 1 },
          users: {
            $push: {
              _id: '$_id',
              email: '$email',
              username: '$username',
            },
          },
        },
      },
    ]);

    for (const row of blockAgg) {
      const creatorId = row._id.toString();
      for (const u of row.users.slice(0, 5)) {
        bump(creatorId, {
          blockedBy: {
            userId: u._id.toString(),
            label: u.username || u.email || u._id.toString(),
          },
        });
      }
      bump(creatorId, { blockCount: row.blockCount });
    }

    const reportTickets = await SupportTicket.find({
      $or: [
        { reportedCreatorUserId: { $exists: true, $ne: null } },
        { reportedCreatorFirebaseUid: { $exists: true, $ne: null } },
        { category: 'abuse', subject: { $regex: /^Creator report/i } },
      ],
    })
      .select('reportedCreatorUserId reportedCreatorFirebaseUid createdAt')
      .sort({ createdAt: -1 })
      .limit(5000)
      .lean();

    const reportUserIds = [
      ...new Set(
        reportTickets
          .map((t) => t.reportedCreatorUserId?.toString())
          .filter((id): id is string => !!id)
      ),
    ].map((id) => new mongoose.Types.ObjectId(id));

    const [creatorsByUserId, creatorsByIdGuess] = await Promise.all([
      reportUserIds.length === 0
        ? Promise.resolve([] as Array<{ _id: mongoose.Types.ObjectId; userId: mongoose.Types.ObjectId }>)
        : Creator.find({ userId: { $in: reportUserIds } })
            .select('_id userId')
            .lean(),
      reportUserIds.length === 0
        ? Promise.resolve([] as Array<{ _id: mongoose.Types.ObjectId }>)
        : Creator.find({ _id: { $in: reportUserIds } })
            .select('_id')
            .lean(),
    ]);

    const creatorIdByUserId = new Map(
      creatorsByUserId.map((c) => [c.userId.toString(), c._id.toString()])
    );
    const validCreatorIds = new Set(creatorsByIdGuess.map((c) => c._id.toString()));

    const firebaseUids = [
      ...new Set(
        reportTickets
          .map((t) => t.reportedCreatorFirebaseUid?.trim())
          .filter((uid): uid is string => !!uid)
      ),
    ];
    const creatorByFirebase = new Map<string, string>();
    if (firebaseUids.length > 0) {
      const usersByFirebase = await User.find({
        firebaseUid: { $in: firebaseUids },
        role: 'creator',
      })
        .select('_id firebaseUid')
        .lean();
      if (usersByFirebase.length > 0) {
        const cDocs = await Creator.find({
          userId: { $in: usersByFirebase.map((u) => u._id) },
        })
          .select('_id userId')
          .lean();
        const byUser = new Map(cDocs.map((c) => [c.userId.toString(), c._id.toString()]));
        for (const u of usersByFirebase) {
          const cid = byUser.get(u._id.toString());
          if (cid && u.firebaseUid) creatorByFirebase.set(u.firebaseUid, cid);
        }
      }
    }

    for (const t of reportTickets) {
      let creatorId: string | null = null;
      const uid = t.reportedCreatorUserId?.toString();
      if (uid) {
        creatorId =
          creatorIdByUserId.get(uid) ?? (validCreatorIds.has(uid) ? uid : null);
      }
      if (!creatorId && t.reportedCreatorFirebaseUid) {
        creatorId = creatorByFirebase.get(t.reportedCreatorFirebaseUid.trim()) ?? null;
      }
      if (!creatorId) continue;
      bump(creatorId, {
        reportCount: 1,
        lastReportedAt: t.createdAt,
      });
    }

    const accumulators = [...byCreator.values()].filter(
      (r) => r.blockCount > 0 || r.reportCount > 0
    );

    const creatorIds = accumulators.map((r) => new mongoose.Types.ObjectId(r.creatorId));
    const creators =
      creatorIds.length === 0
        ? []
        : await Creator.find({ _id: { $in: creatorIds } })
            .select('name userId')
            .lean();
    const userIds = creators.map((c) => c.userId).filter(Boolean);
    const users =
      userIds.length === 0
        ? []
        : await User.find({ _id: { $in: userIds } })
            .select('email username phone')
            .lean();
    const userMap = new Map(users.map((u) => [u._id.toString(), u]));
    const creatorMap = new Map(creators.map((c) => [c._id.toString(), c]));

    const enriched = accumulators.map((r) => {
      const c = creatorMap.get(r.creatorId);
      const u = c?.userId ? userMap.get(c.userId.toString()) : undefined;
      return {
        creatorId: r.creatorId,
        hostName: c?.name ?? u?.username ?? u?.email ?? 'Unknown host',
        creatorUserId: c?.userId?.toString() ?? null,
        email: u?.email ?? null,
        username: u?.username ?? null,
        phone: u?.phone ?? null,
        blockCount: r.blockCount,
        reportCount: r.reportCount,
        lastReportedAt: r.lastReportedAt?.toISOString() ?? null,
        blockedBySample: r.blockedBySample,
      };
    });

    enriched.sort((a, b) => {
      switch (sort) {
        case 'reports_desc':
          return b.reportCount - a.reportCount || b.blockCount - a.blockCount;
        case 'name_asc':
          return a.hostName.localeCompare(b.hostName, undefined, { sensitivity: 'base' });
        case 'blocks_asc':
          return a.blockCount - b.blockCount;
        case 'blocks_desc':
        default:
          return b.blockCount - a.blockCount || b.reportCount - a.reportCount;
      }
    });

    const total = enriched.length;
    const skip = (page - 1) * limit;
    const pageRows = enriched.slice(skip, skip + limit);

    res.json({
      success: true,
      data: {
        summary: {
          totalHosts: total,
          totalBlocks: enriched.reduce((s, r) => s + r.blockCount, 0),
          totalReports: enriched.reduce((s, r) => s + r.reportCount, 0),
        },
        rows: pageRows,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
      },
    });
  } catch (error) {
    logError('getBlockedHosts', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
