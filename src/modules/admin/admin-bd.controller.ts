import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { Withdrawal } from '../creator/withdrawal.model';
import { assertAdmin } from '../../middlewares/staff.middleware';
import { invalidateAdminCaches } from '../../config/redis';
import { logError, logInfo } from '../../utils/logger';
import { generateStaffPortalPassword } from '../../utils/staff-password';
import { appendAuditEvent, extractAuditContext } from '../audit/audit-event.service';
import {
  checkDeletedStatus,
  normalizePhone,
  upsertDeletedIdentities,
} from '../user/deleted-identity.service';

const BCRYPT_ROUNDS = 12;
const PHONE_MAX_LEN = 32;

import { AGENCY_ROLE_QUERY } from '../../utils/staff-roles';

function normalizeAgencyPhone(raw: string): string {
  return normalizePhone(raw);
}

export const createBd = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const email = String(req.body.email ?? '')
      .trim()
      .toLowerCase();
    const displayName =
      typeof req.body.displayName === 'string' ? req.body.displayName.trim().slice(0, 120) : undefined;
    const phoneRaw = String(req.body.phone ?? '').trim();
    const phone = phoneRaw ? normalizeAgencyPhone(phoneRaw) : '';
    const placeRaw =
      typeof req.body.agencyPlace === 'string'
        ? req.body.agencyPlace.trim()
        : typeof req.body.place === 'string'
          ? req.body.place.trim()
          : '';
    const agencyPlace = placeRaw ? placeRaw.slice(0, 200) : undefined;

    if (!email) {
      res.status(400).json({ success: false, error: 'Valid email is required' });
      return;
    }
    if (!phone) {
      res.status(400).json({ success: false, error: 'Phone number is required' });
      return;
    }
    if (!agencyPlace) {
      res.status(400).json({ success: false, error: 'Place is required' });
      return;
    }
    if (phone.length > PHONE_MAX_LEN) {
      res.status(400).json({ success: false, error: 'Phone number is too long' });
      return;
    }

    const deletedStatus = await checkDeletedStatus({ email, phone });
    if (deletedStatus.isDeleted) {
      res.status(409).json({
        success: false,
        error: 'This email or phone was previously removed and cannot be reused',
      });
      return;
    }

    const existing = await User.findOne({ email }).select('_id').lean();
    if (existing) {
      res.status(409).json({ success: false, error: 'Email already in use' });
      return;
    }

    const phoneTaken = await User.findOne({ phone }).select('_id').lean();
    if (phoneTaken) {
      res.status(409).json({ success: false, error: 'Phone number already in use' });
      return;
    }

    const plainPassword = generateStaffPortalPassword(16);
    const passwordHash = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);
    const firebaseUid = `agency_${randomUUID().replace(/-/g, '')}`;

    const agency = await User.create({
      firebaseUid,
      email,
      phone,
      role: 'bd',
      passwordHash,
      displayName: displayName || undefined,
      agencyPlace,
      coins: 0,
      bdDisabled: false,
      staffMustChangePassword: true,
    });

    logInfo('Admin created agency', { bdId: agency._id.toString(), email });

    invalidateAdminCaches('overview', 'users_analytics').catch(() => {});

    res.status(201).json({
      success: true,
      data: {
        id: agency._id.toString(),
        email: agency.email,
        phone: agency.phone ?? null,
        agencyPlace: agency.agencyPlace ?? null,
        displayName: agency.displayName ?? null,
        bdDisabled: agency.bdDisabled ?? false,
        generatedPassword: plainPassword,
      },
    });
  } catch (error) {
    logError('createBd error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const listBds = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 30));
    const skip = (page - 1) * limit;

    const [agencies, total] = await Promise.all([
      User.find({ role: 'bd' })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('email phone agencyPlace displayName bdDisabled createdAt')
        .lean(),
      User.countDocuments({ role: 'bd' }),
    ]);

    const ids = agencies.map((a) => a._id);
    const bdCounts = await User.aggregate<{ _id: mongoose.Types.ObjectId; c: number }>([
      { $match: { bdId: { $in: ids }, ...AGENCY_ROLE_QUERY } },
      { $group: { _id: '$bdId', c: { $sum: 1 } } },
    ]);
    const bdMap = new Map(bdCounts.map((r) => [r._id.toString(), r.c]));

    res.json({
      success: true,
      data: {
        bds: agencies.map((a) => ({
          id: a._id.toString(),
          email: a.email,
          phone: a.phone ?? null,
          agencyPlace: a.agencyPlace ?? null,
          displayName: a.displayName ?? null,
          bdDisabled: a.bdDisabled ?? false,
          agencyCount: bdMap.get(a._id.toString()) ?? 0,
          createdAt: a.createdAt,
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    logError('listBds error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getBdDetail = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const { id } = req.params;
    const agency = await User.findOne({ _id: id, role: 'bd' })
      .select('email phone agencyPlace displayName bdDisabled createdAt updatedAt')
      .lean();
    if (!agency) {
      res.status(404).json({ success: false, error: 'Agency not found' });
      return;
    }

    const agencyOid = new mongoose.Types.ObjectId(id);
    const bds = await User.find({ bdId: agencyOid, ...AGENCY_ROLE_QUERY })
      .select('email displayName referralCode agencyDisabled createdAt')
      .sort({ createdAt: -1 })
      .lean();

    const bdIds = bds.map((b) => b._id);
    const hostCounts =
      bdIds.length === 0
        ? []
        : await Creator.aggregate<{ _id: mongoose.Types.ObjectId; c: number }>([
            { $match: { assignedAgencyId: { $in: bdIds } } },
            { $group: { _id: '$assignedAgencyId', c: { $sum: 1 } } },
          ]);
    const hostMap = new Map(hostCounts.map((h) => [h._id.toString(), h.c]));

    res.json({
      success: true,
      data: {
        agency: {
          id: agency._id.toString(),
          email: agency.email,
          phone: agency.phone ?? null,
          agencyPlace: agency.agencyPlace ?? null,
          displayName: agency.displayName ?? null,
          bdDisabled: agency.bdDisabled ?? false,
          createdAt: agency.createdAt,
          updatedAt: agency.updatedAt,
        },
        bds: bds.map((b) => ({
          id: b._id.toString(),
          email: b.email,
          displayName: b.displayName ?? null,
          referralCode: b.referralCode ?? null,
          agencyDisabled: b.agencyDisabled ?? false,
          hostCount: hostMap.get(b._id.toString()) ?? 0,
          createdAt: b.createdAt,
        })),
      },
    });
  } catch (error) {
    logError('getBdDetail error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const patchBd = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const { id } = req.params;
    const agency = await User.findOne({ _id: id, role: 'bd' });
    if (!agency) {
      res.status(404).json({ success: false, error: 'Agency not found' });
      return;
    }

    if (typeof req.body.bdDisabled === 'boolean') {
      agency.bdDisabled = req.body.bdDisabled;
    }
    if (typeof req.body.displayName === 'string') {
      const d = req.body.displayName.trim().slice(0, 120);
      agency.displayName = d || undefined;
    }
    if (typeof req.body.password === 'string' && req.body.password.length >= 8) {
      agency.passwordHash = await bcrypt.hash(req.body.password, BCRYPT_ROUNDS);
      agency.staffMustChangePassword = false;
    }
    if (typeof req.body.phone === 'string') {
      const p = normalizeAgencyPhone(req.body.phone);
      if (p.length > PHONE_MAX_LEN) {
        res.status(400).json({ success: false, error: 'Phone number is too long' });
        return;
      }
      if (p) {
        const taken = await User.findOne({ phone: p, _id: { $ne: agency._id } })
          .select('_id')
          .lean();
        if (taken) {
          res.status(409).json({ success: false, error: 'Phone number already in use' });
          return;
        }
      }
      agency.phone = p || undefined;
    }
    const placeBody =
      typeof req.body.agencyPlace === 'string'
        ? req.body.agencyPlace
        : typeof req.body.place === 'string'
          ? req.body.place
          : undefined;
    if (typeof placeBody === 'string') {
      const pl = placeBody.trim().slice(0, 200);
      agency.agencyPlace = pl || undefined;
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
        bdDisabled: agency.bdDisabled ?? false,
        email: agency.email,
      },
      ...ctx,
    });

    res.json({
      success: true,
      data: {
        id: agency._id.toString(),
        email: agency.email,
        phone: agency.phone ?? null,
        agencyPlace: agency.agencyPlace ?? null,
        displayName: agency.displayName ?? null,
        bdDisabled: agency.bdDisabled ?? false,
      },
    });
  } catch (error) {
    logError('patchBd error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/**
 * Permanently removes the agency User row. Staff JWT verification uses `User.findById`,
 * so tokens become unusable once the document is gone (invalid JWT falls through to Firebase and fails).
 */
export const deleteBd = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, error: 'Invalid agency id' });
      return;
    }

    const agency = await User.findOne({ _id: id, role: 'bd' })
      .select('email phone staffCoinsBalance')
      .lean();
    if (!agency) {
      res.status(404).json({ success: false, error: 'Agency not found' });
      return;
    }

    const agencyOid = agency._id;

    const [bdCount, pendingPayouts, balance] = await Promise.all([
      User.countDocuments({ bdId: agencyOid, ...AGENCY_ROLE_QUERY }),
      Withdrawal.countDocuments({ staffUserId: agencyOid, status: 'pending' }),
      Promise.resolve(Number(agency.staffCoinsBalance) || 0),
    ]);

    if (bdCount > 0) {
      res.status(409).json({
        success: false,
        error: `Cannot remove agency: ${bdCount} BD account(s) still exist under this agency. Remove or re-home them first.`,
      });
      return;
    }
    if (pendingPayouts > 0) {
      res.status(409).json({
        success: false,
        error: 'Cannot remove agency: pending staff withdrawal(s) exist for this agency.',
      });
      return;
    }
    if (balance > 0) {
      res.status(409).json({
        success: false,
        error: 'Cannot remove agency: staff wallet balance must be zero first.',
      });
      return;
    }

    await upsertDeletedIdentities({
      email: agency.email ?? null,
      phone: agency.phone ?? null,
    });

    await User.deleteOne({ _id: agencyOid });

    logInfo('Admin deleted agency', { bdId: agencyOid.toString(), email: agency.email });

    invalidateAdminCaches('overview', 'users_analytics').catch(() => {});

    const actor = await User.findOne({ firebaseUid: req.auth?.firebaseUid })
      .select('_id role')
      .lean();
    const ctx = extractAuditContext(req);
    void appendAuditEvent({
      actorUserId: actor?._id ?? null,
      actorRole: actor?.role,
      eventType: 'agency_deleted',
      targetType: 'agency',
      targetId: id,
      metadata: {
        email: agency.email,
      },
      ...ctx,
    });

    res.json({ success: true, data: { id: agencyOid.toString(), deleted: true } });
  } catch (error) {
    logError('deleteBd error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
