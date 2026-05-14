import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { User, type IUser } from '../modules/user/user.model';
import { Creator } from '../modules/creator/creator.model';
import {
  isAgencyRole,
  isBdRole,
  isSuperAdminRole,
  isAgencyStaffDisabled,
  isBdStaffDisabled,
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

/** Top-tier BD portal (`role === 'bd'`). */
export async function assertBd(req: Request, res: Response): Promise<boolean> {
  if (!req.auth) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  const u = await User.findOne({ firebaseUid: req.auth.firebaseUid })
    .select('role bdDisabled')
    .lean();
  if (!u || !isBdRole(u.role) || isBdStaffDisabled(u)) {
    res.status(403).json({ success: false, error: 'BD access required' });
    return false;
  }
  return true;
}

/** Middle-tier agency portal (`role === 'agency'`). */
export async function assertAgency(req: Request, res: Response): Promise<boolean> {
  if (!req.auth) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  const u = await User.findOne({ firebaseUid: req.auth.firebaseUid })
    .select('role agencyDisabled bdId')
    .lean();
  if (!u || !isAgencyRole(u.role) || isAgencyStaffDisabled(u)) {
    res.status(403).json({ success: false, error: 'Agency access required' });
    return false;
  }
  if (u.bdId) {
    const parent = await User.findById(u.bdId).select('role bdDisabled').lean();
    if (!parent || !isBdRole(parent.role)) {
      res.status(403).json({
        success: false,
        error: 'BD no longer exists — agency portal access suspended',
      });
      return false;
    }
    if (parent.bdDisabled) {
      res.status(403).json({
        success: false,
        error: 'BD account is disabled — agency portal access suspended',
      });
      return false;
    }
  }
  return true;
}

export async function assertAdminOrAgency(req: Request, res: Response): Promise<boolean> {
  if (!req.auth) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  const u = await User.findOne({ firebaseUid: req.auth.firebaseUid })
    .select('role agencyDisabled')
    .lean();
  if (!u) {
    res.status(403).json({ success: false, error: 'Admin or agency access required' });
    return false;
  }
  if (isSuperAdminRole(u.role)) return true;
  if (isAgencyRole(u.role)) {
    if (isAgencyStaffDisabled(u)) {
      res.status(403).json({ success: false, error: 'Agency access required' });
      return false;
    }
    return true;
  }
  res.status(403).json({ success: false, error: 'Admin or agency access required' });
  return false;
}

/** @deprecated Use assertAdminOrAgency */
export async function assertAdminOrAgent(req: Request, res: Response): Promise<boolean> {
  return assertAdminOrAgency(req, res);
}

/**
 * Admin may edit any creator; agency staff may edit only creators assigned to them.
 */
export async function assertAdminOrOwningAgencyForCreator(
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
    .select('_id role agencyDisabled')
    .lean();
  if (!u) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  if (isSuperAdminRole(u.role)) return true;
  if (isAgencyRole(u.role) && !isAgencyStaffDisabled(u)) {
    const c = await Creator.findById(creatorMongoId).select('assignedAgencyId').lean();
    if (c?.assignedAgencyId?.equals(u._id)) return true;
  }
  res.status(403).json({
    success: false,
    error: 'Forbidden: Admin access or ownership of this creator is required',
  });
  return false;
}

/** @deprecated Use assertAdminOrOwningAgencyForCreator */
export async function assertAdminOrOwningAgentForCreator(
  req: Request,
  res: Response,
  creatorMongoId: string
): Promise<boolean> {
  return assertAdminOrOwningAgencyForCreator(req, res, creatorMongoId);
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
