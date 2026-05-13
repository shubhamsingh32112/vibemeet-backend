import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { User, type IUser } from '../modules/user/user.model';
import { Creator } from '../modules/creator/creator.model';
import {
  isAgencyRole,
  isBdRole,
  isStaffRecruiterDisabled,
  isSuperAdminRole,
  isAgencyStaffDisabled,
} from '../utils/staff-roles';

export async function loadStaffUserByAuth(req: Request): Promise<IUser | null> {
  if (!req.auth?.firebaseUid) return null;
  return User.findOne({ firebaseUid: req.auth.firebaseUid });
}

/** Full admin dashboard /admin APIs (legacy `admin` + `super_admin`). */
export async function assertAdmin(req: Request, res: Response): Promise<boolean> {
  if (!req.auth) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  const u = await User.findOne({ firebaseUid: req.auth.firebaseUid }).select('role').lean();
  if (!u || !isSuperAdminRole(u.role)) {
    res.status(403).json({ success: false, error: 'Admin access required' });
    return false;
  }
  return true;
}

export async function assertSuperAdmin(req: Request, res: Response): Promise<boolean> {
  return assertAdmin(req, res);
}

/** BD portal (`bd` + legacy `agent`). */
export async function assertAgent(req: Request, res: Response): Promise<boolean> {
  if (!req.auth) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  const u = await User.findOne({ firebaseUid: req.auth.firebaseUid })
    .select('role agentDisabled agencyId')
    .lean();
  if (!u || !isBdRole(u.role) || isStaffRecruiterDisabled(u)) {
    res.status(403).json({ success: false, error: 'Agent access required' });
    return false;
  }
  if (u.agencyId) {
    const parent = await User.findById(u.agencyId).select('role agencyDisabled').lean();
    if (!parent || parent.role !== 'agency') {
      res.status(403).json({
        success: false,
        error: 'Agency no longer exists — BD portal access suspended',
      });
      return false;
    }
    if (parent.agencyDisabled) {
      res.status(403).json({
        success: false,
        error: 'Agency account is disabled — BD portal access suspended',
      });
      return false;
    }
  }
  return true;
}

export async function assertBd(req: Request, res: Response): Promise<boolean> {
  return assertAgent(req, res);
}

export async function assertAgency(req: Request, res: Response): Promise<boolean> {
  if (!req.auth) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  const u = await User.findOne({ firebaseUid: req.auth.firebaseUid })
    .select('role agencyDisabled')
    .lean();
  if (!u || !isAgencyRole(u.role) || isAgencyStaffDisabled(u)) {
    res.status(403).json({ success: false, error: 'Agency access required' });
    return false;
  }
  return true;
}

export async function assertAdminOrAgent(req: Request, res: Response): Promise<boolean> {
  if (!req.auth) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  const u = await User.findOne({ firebaseUid: req.auth.firebaseUid })
    .select('role agentDisabled')
    .lean();
  if (!u) {
    res.status(403).json({ success: false, error: 'Admin or agent access required' });
    return false;
  }
  if (isSuperAdminRole(u.role)) return true;
  if (isBdRole(u.role)) {
    if (isStaffRecruiterDisabled(u)) {
      res.status(403).json({ success: false, error: 'Agent access required' });
      return false;
    }
    return true;
  }
  res.status(403).json({ success: false, error: 'Admin or agent access required' });
  return false;
}

/**
 * Admin may edit any creator; BD/agents may edit only creators assigned to them.
 */
export async function assertAdminOrOwningAgentForCreator(
  req: Request,
  res: Response,
  creatorMongoId: string
): Promise<boolean> {
  if (!req.auth) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  if (!mongoose.Types.ObjectId.isValid(creatorMongoId)) {
    res.status(400).json({ success: false, error: 'Invalid creator id' });
    return false;
  }
  const u = await User.findOne({ firebaseUid: req.auth.firebaseUid })
    .select('_id role agentDisabled')
    .lean();
  if (!u) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  if (isSuperAdminRole(u.role)) return true;
  if (isBdRole(u.role) && !isStaffRecruiterDisabled(u)) {
    const c = await Creator.findById(creatorMongoId).select('assignedAgentId').lean();
    if (c?.assignedAgentId?.equals(u._id)) return true;
  }
  res.status(403).json({
    success: false,
    error: 'Forbidden: Admin access or ownership of this creator is required',
  });
  return false;
}

export type SuperAdminStaffCapabilityKey = 'editPricing' | 'managePlatformRevenue';

/** Fine-grained toggles on super-admin User docs (defaults allow). */
export async function assertSuperAdminStaffCapability(
  req: Request,
  res: Response,
  key: SuperAdminStaffCapabilityKey
): Promise<boolean> {
  if (!(await assertAdmin(req, res))) return false;
  const u = await User.findOne({ firebaseUid: req.auth!.firebaseUid })
    .select('staffCapabilities')
    .lean();
  if (u?.staffCapabilities?.[key] === false) {
    res.status(403).json({
      success: false,
      error: `Insufficient permission: ${key}`,
    });
    return false;
  }
  return true;
}
