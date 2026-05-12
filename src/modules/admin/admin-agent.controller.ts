import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { ReferralEdge } from '../user/referral-edge.model';
import { Withdrawal } from '../creator/withdrawal.model';
import { assignReferralCodeToUser } from '../user/referral.service';
import { assertAdmin } from '../../middlewares/staff.middleware';
import { invalidateAdminCaches } from '../../config/redis';
import { logError, logInfo } from '../../utils/logger';

const BCRYPT_ROUNDS = 12;

/** Legacy Mongo stored `agent`; new rows use `bd`. */
const BD_ROLE_QUERY = { $in: ['agent', 'bd'] as const };

export const createAgent = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const email = String(req.body.email ?? '')
      .trim()
      .toLowerCase();
    const password = String(req.body.password ?? '');
    const displayName =
      typeof req.body.displayName === 'string' ? req.body.displayName.trim().slice(0, 120) : undefined;

    if (!email || !password || password.length < 8) {
      res.status(400).json({
        success: false,
        error: 'Valid email and password (min 8 characters) are required',
      });
      return;
    }

    const existing = await User.findOne({ email }).select('_id').lean();
    if (existing) {
      res.status(409).json({ success: false, error: 'Email already in use' });
      return;
    }

    let agencyId: mongoose.Types.ObjectId | undefined;
    const rawAgencyId = req.body.agencyId;
    if (typeof rawAgencyId === 'string' && mongoose.Types.ObjectId.isValid(rawAgencyId)) {
      const ag = await User.findById(rawAgencyId).select('role').lean();
      if (ag?.role === 'agency') {
        agencyId = new mongoose.Types.ObjectId(rawAgencyId);
      }
    }

    const firebaseUid = `bd_${randomUUID().replace(/-/g, '')}`;
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const agent = await User.create({
      firebaseUid,
      email,
      role: 'bd',
      passwordHash,
      displayName: displayName || undefined,
      coins: 0,
      agentDisabled: false,
      ...(agencyId ? { agencyId } : {}),
    });

    await assignReferralCodeToUser(agent);

    logInfo('Admin created agent', { agentId: agent._id.toString(), email });

    invalidateAdminCaches('overview', 'users_analytics').catch(() => {});

    res.status(201).json({
      success: true,
      data: {
        id: agent._id.toString(),
        email: agent.email,
        displayName: agent.displayName ?? null,
        referralCode: agent.referralCode ?? null,
        agentDisabled: agent.agentDisabled ?? false,
      },
    });
  } catch (error) {
    logError('createAgent error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const listAgents = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 30));
    const skip = (page - 1) * limit;

    const [agents, total] = await Promise.all([
      User.find({ role: BD_ROLE_QUERY })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('email displayName referralCode agentDisabled agencyId createdAt')
        .lean(),
      User.countDocuments({ role: BD_ROLE_QUERY }),
    ]);

    const ids = agents.map((a) => a._id);
    const [awaitingCounts, creatorCounts, pendingWithdrawals] = await Promise.all([
      User.aggregate<{ _id: mongoose.Types.ObjectId; c: number }>([
        { $match: { referredBy: { $in: ids } } },
        { $lookup: { from: 'creators', localField: '_id', foreignField: 'userId', as: 'cr' } },
        { $match: { $expr: { $eq: [{ $size: '$cr' }, 0] } } },
        { $group: { _id: '$referredBy', c: { $sum: 1 } } },
      ]),
      Creator.aggregate([
        { $match: { assignedAgentId: { $in: ids } } },
        { $group: { _id: '$assignedAgentId', c: { $sum: 1 } } },
      ]),
      Withdrawal.aggregate([
        {
          $match: {
            assignedAgentId: { $in: ids },
            status: 'pending',
          },
        },
        { $group: { _id: '$assignedAgentId', c: { $sum: 1 } } },
      ]),
    ]);

    const pendingMap = new Map(awaitingCounts.map((p) => [p._id.toString(), p.c]));
    const creatorMap = new Map(creatorCounts.map((p: { _id: mongoose.Types.ObjectId; c: number }) => [p._id.toString(), p.c]));
    const wdMap = new Map(pendingWithdrawals.map((p: { _id: mongoose.Types.ObjectId; c: number }) => [p._id.toString(), p.c]));

    res.json({
      success: true,
      data: {
        agents: agents.map((a) => ({
          id: a._id.toString(),
          email: a.email,
          displayName: a.displayName ?? null,
          referralCode: a.referralCode ?? null,
          agentDisabled: a.agentDisabled ?? false,
          agencyId: (a as { agencyId?: mongoose.Types.ObjectId }).agencyId?.toString() ?? null,
          createdAt: a.createdAt,
          /** Referred users not yet promoted to creator (legacy field name). */
          pendingApplications: pendingMap.get(a._id.toString()) ?? 0,
          activeCreators: creatorMap.get(a._id.toString()) ?? 0,
          pendingWithdrawals: wdMap.get(a._id.toString()) ?? 0,
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    logError('listAgents error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/** Minimal agent list for filters (e.g. user analytics referrer dropdown) — no aggregates. */
export const listAgentsBrief = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const agents = await User.find({ role: BD_ROLE_QUERY })
      .sort({ email: 1 })
      .select('_id email displayName')
      .lean();

    res.json({
      success: true,
      data: {
        agents: agents.map((a) => ({
          id: a._id.toString(),
          email: a.email,
          displayName: a.displayName ?? null,
        })),
      },
    });
  } catch (error) {
    logError('listAgentsBrief error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getAgentDetail = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const { id } = req.params;
    const agent = await User.findOne({ _id: id, role: BD_ROLE_QUERY })
      .select('email displayName referralCode agentDisabled agencyId createdAt updatedAt')
      .lean();
    if (!agent) {
      res.status(404).json({ success: false, error: 'Agent not found' });
      return;
    }

    const agentOid = new mongoose.Types.ObjectId(id);

    const awaitingRaw = await User.aggregate<{
      _id: mongoose.Types.ObjectId;
      email?: string;
      phone?: string;
      username?: string;
      firebaseUid?: string;
      createdAt: Date;
    }>([
      { $match: { referredBy: agentOid } },
      { $lookup: { from: 'creators', localField: '_id', foreignField: 'userId', as: 'cr' } },
      { $match: { $expr: { $eq: [{ $size: '$cr' }, 0] } } },
      { $sort: { createdAt: -1 } },
      { $limit: 200 },
      { $project: { email: 1, phone: 1, username: 1, firebaseUid: 1, createdAt: 1 } },
    ]);

    const awaitingIds = awaitingRaw.map((u) => u._id);
    const edges = await ReferralEdge.find({ referredUserId: { $in: awaitingIds } })
      .select('referredUserId referralCodeUsed')
      .lean();
    const codeByUser = new Map(edges.map((e) => [e.referredUserId.toString(), e.referralCodeUsed]));

    const [creators, pendingWd] = await Promise.all([
      Creator.find({ assignedAgentId: agentOid })
        .select('name photo userId earningsCoins createdAt')
        .sort({ updatedAt: -1 })
        .limit(500)
        .lean(),
      Withdrawal.countDocuments({ assignedAgentId: agentOid, status: 'pending' }),
    ]);

    res.json({
      success: true,
      data: {
        agent: {
          id: agent._id.toString(),
          email: agent.email,
          displayName: agent.displayName ?? null,
          referralCode: agent.referralCode ?? null,
          agentDisabled: agent.agentDisabled ?? false,
          agencyId: (agent as { agencyId?: mongoose.Types.ObjectId }).agencyId?.toString() ?? null,
          createdAt: agent.createdAt,
          updatedAt: agent.updatedAt,
        },
        pendingApplications: awaitingRaw.map((u) => {
          const uid = u._id.toString();
          return {
            id: uid,
            applicantUserId: uid,
            applicant: {
              _id: u._id,
              email: u.email,
              phone: u.phone,
              username: u.username,
              firebaseUid: u.firebaseUid,
            },
            referralCodeUsed: codeByUser.get(uid) ?? agent.referralCode ?? '',
            createdAt: u.createdAt,
          };
        }),
        creators: creators.map((c) => ({
          id: c._id.toString(),
          userId: c.userId.toString(),
          name: c.name,
          earningsCoins: c.earningsCoins,
          createdAt: c.createdAt,
        })),
        pendingWithdrawalsCount: pendingWd,
      },
    });
  } catch (error) {
    logError('getAgentDetail error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const patchAgent = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const { id } = req.params;
    const agent = await User.findOne({ _id: id, role: BD_ROLE_QUERY });
    if (!agent) {
      res.status(404).json({ success: false, error: 'Agent not found' });
      return;
    }

    if (typeof req.body.agentDisabled === 'boolean') {
      agent.agentDisabled = req.body.agentDisabled;
    }
    if (typeof req.body.displayName === 'string') {
      const d = req.body.displayName.trim().slice(0, 120);
      agent.displayName = d || undefined;
    }
    if (typeof req.body.password === 'string' && req.body.password.length >= 8) {
      agent.passwordHash = await bcrypt.hash(req.body.password, BCRYPT_ROUNDS);
    }
    if (req.body.reassignCreatorsToAgentId) {
      const targetId = String(req.body.reassignCreatorsToAgentId).trim();
      if (!mongoose.Types.ObjectId.isValid(targetId)) {
        res.status(400).json({ success: false, error: 'Invalid reassignCreatorsToAgentId' });
        return;
      }
      const target = await User.findOne({
        _id: targetId,
        role: BD_ROLE_QUERY,
        agentDisabled: false,
      });
      if (!target) {
        res.status(404).json({ success: false, error: 'Target agent not found or disabled' });
        return;
      }
      await Creator.updateMany(
        { assignedAgentId: agent._id },
        { $set: { assignedAgentId: target._id } },
      );
      await Withdrawal.updateMany(
        { assignedAgentId: agent._id, status: 'pending' },
        { $set: { assignedAgentId: target._id } },
      );
    }

    await agent.save();

    invalidateAdminCaches('overview', 'users_analytics', 'creators_performance').catch(() => {});

    res.json({
      success: true,
      data: {
        id: agent._id.toString(),
        email: agent.email,
        displayName: agent.displayName ?? null,
        agentDisabled: agent.agentDisabled ?? false,
      },
    });
  } catch (error) {
    logError('patchAgent error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
