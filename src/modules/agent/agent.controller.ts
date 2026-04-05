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

    const [pendingApps, pendingWd, creators] = await Promise.all([
      CreatorApplication.countDocuments({ agentUserId: agent._id, status: 'pending' }),
      Withdrawal.countDocuments({ assignedAgentId: agent._id, status: 'pending' }),
      Creator.countDocuments({ assignedAgentId: agent._id }),
    ]);

    res.json({
      success: true,
      data: {
        pendingApplications: pendingApps,
        pendingWithdrawals: pendingWd,
        activeCreators: creators,
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

    const sort = (req.query.sort as string) === 'earnings' ? 'earningsCoins' : 'updatedAt';
    const dir = (req.query.dir as string) === 'asc' ? 1 : -1;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const skip = (page - 1) * limit;

    const [creators, total] = await Promise.all([
      Creator.find({ assignedAgentId: agent._id })
        .sort({ [sort]: dir })
        .skip(skip)
        .limit(limit)
        .lean(),
      Creator.countDocuments({ assignedAgentId: agent._id }),
    ]);

    const userIds = creators.map((c) => c.userId);
    const users = await User.find({ _id: { $in: userIds } })
      .select('username email phone coins')
      .lean();
    const userMap = new Map(users.map((u) => [u._id.toString(), u]));

    res.json({
      success: true,
      data: {
        creators: creators.map((c) => {
          const u = userMap.get(c.userId.toString());
          return {
            id: c._id.toString(),
            userId: c.userId.toString(),
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
          };
        }),
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

    const { creatorId } = req.params;
    const creator = await Creator.findById(creatorId).lean();
    if (!creator || !creator.assignedAgentId?.equals(agent._id)) {
      res.status(404).json({ success: false, error: 'Creator not found' });
      return;
    }

    const user = await User.findById(creator.userId).lean();
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const [e1d, e7d, e30d] = await Promise.all([
      earningsInWindow(user._id, sinceDaysAgo(1)),
      earningsInWindow(user._id, sinceDaysAgo(7)),
      earningsInWindow(user._id, sinceDaysAgo(30)),
    ]);

    res.json({
      success: true,
      data: {
        creator: {
          id: creator._id.toString(),
          userId: creator.userId.toString(),
          name: creator.name,
          about: creator.about,
          photo: creator.photo,
          galleryImages: creator.galleryImages,
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
          profileRevision: user.profileRevision,
        },
        earningsSummaryCoins: { last1d: e1d, last7d: e7d, last30d: e30d },
      },
    });
  } catch (error) {
    logError('getAgentCreatorDetail', error as Error);
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
