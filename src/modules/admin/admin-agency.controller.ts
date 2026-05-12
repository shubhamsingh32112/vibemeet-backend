import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { assertAdmin } from '../../middlewares/staff.middleware';
import { invalidateAdminCaches } from '../../config/redis';
import { logError, logInfo } from '../../utils/logger';
import { generateStaffPortalPassword } from '../../utils/staff-password';
import { appendAuditEvent, extractAuditContext } from '../audit/audit-event.service';

const BCRYPT_ROUNDS = 12;

const BD_ROLE_QUERY = { $in: ['agent', 'bd'] as const };

export const createAgency = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const email = String(req.body.email ?? '')
      .trim()
      .toLowerCase();
    const displayName =
      typeof req.body.displayName === 'string' ? req.body.displayName.trim().slice(0, 120) : undefined;

    if (!email) {
      res.status(400).json({ success: false, error: 'Valid email is required' });
      return;
    }

    const existing = await User.findOne({ email }).select('_id').lean();
    if (existing) {
      res.status(409).json({ success: false, error: 'Email already in use' });
      return;
    }

    const plainPassword = generateStaffPortalPassword(16);
    const passwordHash = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);
    const firebaseUid = `agency_${randomUUID().replace(/-/g, '')}`;

    const agency = await User.create({
      firebaseUid,
      email,
      role: 'agency',
      passwordHash,
      displayName: displayName || undefined,
      coins: 0,
      agencyDisabled: false,
    });

    logInfo('Admin created agency', { agencyId: agency._id.toString(), email });

    invalidateAdminCaches('overview', 'users_analytics').catch(() => {});

    res.status(201).json({
      success: true,
      data: {
        id: agency._id.toString(),
        email: agency.email,
        displayName: agency.displayName ?? null,
        agencyDisabled: agency.agencyDisabled ?? false,
        generatedPassword: plainPassword,
      },
    });
  } catch (error) {
    logError('createAgency error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const listAgencies = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 30));
    const skip = (page - 1) * limit;

    const [agencies, total] = await Promise.all([
      User.find({ role: 'agency' })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('email displayName agencyDisabled createdAt')
        .lean(),
      User.countDocuments({ role: 'agency' }),
    ]);

    const ids = agencies.map((a) => a._id);
    const bdCounts = await User.aggregate<{ _id: mongoose.Types.ObjectId; c: number }>([
      { $match: { agencyId: { $in: ids }, role: BD_ROLE_QUERY } },
      { $group: { _id: '$agencyId', c: { $sum: 1 } } },
    ]);
    const bdMap = new Map(bdCounts.map((r) => [r._id.toString(), r.c]));

    res.json({
      success: true,
      data: {
        agencies: agencies.map((a) => ({
          id: a._id.toString(),
          email: a.email,
          displayName: a.displayName ?? null,
          agencyDisabled: a.agencyDisabled ?? false,
          bdCount: bdMap.get(a._id.toString()) ?? 0,
          createdAt: a.createdAt,
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    logError('listAgencies error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getAgencyDetail = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const { id } = req.params;
    const agency = await User.findOne({ _id: id, role: 'agency' })
      .select('email displayName agencyDisabled createdAt updatedAt')
      .lean();
    if (!agency) {
      res.status(404).json({ success: false, error: 'Agency not found' });
      return;
    }

    const agencyOid = new mongoose.Types.ObjectId(id);
    const bds = await User.find({ agencyId: agencyOid, role: BD_ROLE_QUERY })
      .select('email displayName referralCode agentDisabled createdAt')
      .sort({ createdAt: -1 })
      .lean();

    const bdIds = bds.map((b) => b._id);
    const hostCounts =
      bdIds.length === 0
        ? []
        : await Creator.aggregate<{ _id: mongoose.Types.ObjectId; c: number }>([
            { $match: { assignedAgentId: { $in: bdIds } } },
            { $group: { _id: '$assignedAgentId', c: { $sum: 1 } } },
          ]);
    const hostMap = new Map(hostCounts.map((h) => [h._id.toString(), h.c]));

    res.json({
      success: true,
      data: {
        agency: {
          id: agency._id.toString(),
          email: agency.email,
          displayName: agency.displayName ?? null,
          agencyDisabled: agency.agencyDisabled ?? false,
          createdAt: agency.createdAt,
          updatedAt: agency.updatedAt,
        },
        bds: bds.map((b) => ({
          id: b._id.toString(),
          email: b.email,
          displayName: b.displayName ?? null,
          referralCode: b.referralCode ?? null,
          agentDisabled: b.agentDisabled ?? false,
          hostCount: hostMap.get(b._id.toString()) ?? 0,
          createdAt: b.createdAt,
        })),
      },
    });
  } catch (error) {
    logError('getAgencyDetail error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const patchAgency = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const { id } = req.params;
    const agency = await User.findOne({ _id: id, role: 'agency' });
    if (!agency) {
      res.status(404).json({ success: false, error: 'Agency not found' });
      return;
    }

    if (typeof req.body.agencyDisabled === 'boolean') {
      agency.agencyDisabled = req.body.agencyDisabled;
    }
    if (typeof req.body.displayName === 'string') {
      const d = req.body.displayName.trim().slice(0, 120);
      agency.displayName = d || undefined;
    }
    if (typeof req.body.password === 'string' && req.body.password.length >= 8) {
      agency.passwordHash = await bcrypt.hash(req.body.password, BCRYPT_ROUNDS);
    }

    await agency.save();

    invalidateAdminCaches('overview', 'users_analytics').catch(() => {});

    const actor = await User.findOne({ firebaseUid: req.auth?.firebaseUid })
      .select('_id role')
      .lean();
    const ctx = extractAuditContext(req);
    void appendAuditEvent({
      actorUserId: actor?._id ?? null,
      actorRole: actor?.role,
      eventType: 'agency_patched',
      targetType: 'agency',
      targetId: id,
      metadata: {
        agencyDisabled: agency.agencyDisabled ?? false,
        email: agency.email,
      },
      ...ctx,
    });

    res.json({
      success: true,
      data: {
        id: agency._id.toString(),
        email: agency.email,
        displayName: agency.displayName ?? null,
        agencyDisabled: agency.agencyDisabled ?? false,
      },
    });
  } catch (error) {
    logError('patchAgency error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
