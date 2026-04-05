import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { User, type IUser } from '../modules/user/user.model';
import { Creator } from '../modules/creator/creator.model';

export async function loadStaffUserByAuth(req: Request): Promise<IUser | null> {
  if (!req.auth?.firebaseUid) return null;
  return User.findOne({ firebaseUid: req.auth.firebaseUid });
}

export async function assertAdmin(req: Request, res: Response): Promise<boolean> {
  if (!req.auth) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  const u = await User.findOne({ firebaseUid: req.auth.firebaseUid }).select('role').lean();
  if (!u || u.role !== 'admin') {
    res.status(403).json({ success: false, error: 'Admin access required' });
    return false;
  }
  return true;
}

export async function assertAgent(req: Request, res: Response): Promise<boolean> {
  if (!req.auth) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  const u = await User.findOne({ firebaseUid: req.auth.firebaseUid })
    .select('role agentDisabled')
    .lean();
  if (!u || u.role !== 'agent' || u.agentDisabled) {
    res.status(403).json({ success: false, error: 'Agent access required' });
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
  if (!u || u.role === 'user' || u.role === 'creator') {
    res.status(403).json({ success: false, error: 'Admin or agent access required' });
    return false;
  }
  if (u.role === 'agent' && u.agentDisabled) {
    res.status(403).json({ success: false, error: 'Agent access required' });
    return false;
  }
  return true;
}

/**
 * Admin may edit any creator; agents may edit only creators assigned to them.
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
  if (u.role === 'admin') return true;
  if (u.role === 'agent' && !u.agentDisabled) {
    const c = await Creator.findById(creatorMongoId).select('assignedAgentId').lean();
    if (c?.assignedAgentId?.equals(u._id)) return true;
  }
  res.status(403).json({
    success: false,
    error: 'Forbidden: Admin access or ownership of this creator is required',
  });
  return false;
}
