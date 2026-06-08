import type { Request } from 'express';
import { Response } from 'express';
import mongoose from 'mongoose';
import { User } from '../user/user.model';
import { VipMembership } from './models/vip-membership.model';
import {
  getOrCreateVipPlanConfig,
  getOrCreateVipPlans,
  getVipPlanById,
  listVipPlanConfigs,
} from './models/vip-plan-config.model';
import { VipDailyMomentUsage } from './models/vip-daily-moment-usage.model';
import { invalidateVipCache } from './vip-entitlement.service';
import { DEFAULT_VIP_PLAN, DEFAULT_VIP_PLANS } from './vip.config';

export const getAdminVipPlan = async (_req: Request, res: Response): Promise<void> => {
  const plan = await getOrCreateVipPlanConfig();
  res.json({ success: true, data: plan });
};

export const listAdminVipPlans = async (_req: Request, res: Response): Promise<void> => {
  const plans = await listVipPlanConfigs();
  res.json({ success: true, data: plans });
};

export const updateAdminVipPlan = async (req: Request, res: Response): Promise<void> => {
  const {
    durationDays,
    priceInr,
    isActive,
    freeMomentsPerDay,
    rechargeDiscountBps,
    momentDiscountBps,
    label,
    badge,
    sortOrder,
  } = req.body as Record<string, unknown>;

  const plan = await getOrCreateVipPlanConfig();
  if (typeof durationDays === 'number' && durationDays > 0) plan.durationDays = durationDays;
  if (typeof priceInr === 'number' && priceInr > 0) plan.priceInr = priceInr;
  if (typeof isActive === 'boolean') plan.isActive = isActive;
  if (typeof freeMomentsPerDay === 'number' && freeMomentsPerDay >= 0) {
    plan.freeMomentsPerDay = freeMomentsPerDay;
  }
  if (typeof rechargeDiscountBps === 'number') plan.rechargeDiscountBps = rechargeDiscountBps;
  if (typeof momentDiscountBps === 'number') plan.momentDiscountBps = momentDiscountBps;
  if (typeof label === 'string' && label.trim().length > 0) plan.label = label.trim();
  if (badge === 'mostPopular' || badge === 'bestValue' || badge === null) {
    plan.badge = badge;
  }
  if (typeof sortOrder === 'number') plan.sortOrder = sortOrder;
  await plan.save();
  res.json({ success: true, data: plan });
};

export const updateAdminVipPlanById = async (req: Request, res: Response): Promise<void> => {
  const planId = req.params.planId;
  const plan = await getVipPlanById(planId);
  if (!plan) {
    res.status(404).json({ success: false, error: 'VIP plan not found' });
    return;
  }

  const {
    durationDays,
    priceInr,
    isActive,
    freeMomentsPerDay,
    rechargeDiscountBps,
    momentDiscountBps,
    label,
    badge,
    sortOrder,
  } = req.body as Record<string, unknown>;

  if (typeof durationDays === 'number' && durationDays > 0) plan.durationDays = durationDays;
  if (typeof priceInr === 'number' && priceInr > 0) plan.priceInr = priceInr;
  if (typeof isActive === 'boolean') plan.isActive = isActive;
  if (typeof freeMomentsPerDay === 'number' && freeMomentsPerDay >= 0) {
    plan.freeMomentsPerDay = freeMomentsPerDay;
  }
  if (typeof rechargeDiscountBps === 'number') plan.rechargeDiscountBps = rechargeDiscountBps;
  if (typeof momentDiscountBps === 'number') plan.momentDiscountBps = momentDiscountBps;
  if (typeof label === 'string' && label.trim().length > 0) plan.label = label.trim();
  if (badge === 'mostPopular' || badge === 'bestValue' || badge === null) {
    plan.badge = badge;
  }
  if (typeof sortOrder === 'number') plan.sortOrder = sortOrder;
  await plan.save();
  res.json({ success: true, data: plan });
};

export const listAdminVipMembers = async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const status = req.query.status as string | undefined;

  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;

  const members = await VipMembership.find(filter)
    .sort({ expiresAt: -1 })
    .limit(limit)
    .populate('userId', 'username email phone firebaseUid')
    .lean();

  res.json({
    success: true,
    data: members.map((m) => ({
      id: m._id.toString(),
      userId: (m.userId as { _id?: mongoose.Types.ObjectId })?._id?.toString(),
      username: (m.userId as { username?: string })?.username,
      email: (m.userId as { email?: string })?.email,
      status: m.status,
      planId: m.planId,
      startedAt: m.startedAt,
      expiresAt: m.expiresAt,
    })),
  });
};

export const grantAdminVipMembership = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { durationDays } = req.body as { durationDays?: number };
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404).json({ success: false, error: 'User not found' });
    return;
  }

  const plan = await getOrCreateVipPlanConfig();
  const days = durationDays && durationDays > 0 ? durationDays : plan.durationDays;
  const now = new Date();
  const existing = await VipMembership.findOne({ userId: user._id });
  const baseExpiry =
    existing && existing.status === 'active' && existing.expiresAt > now
      ? existing.expiresAt
      : now;
  const expiresAt = new Date(baseExpiry.getTime() + days * 24 * 60 * 60 * 1000);

  if (existing) {
    existing.status = 'active';
    existing.expiresAt = expiresAt;
    existing.planId = plan.planId;
    await existing.save();
  } else {
    await VipMembership.create({
      userId: user._id,
      status: 'active',
      planId: plan.planId,
      startedAt: now,
      expiresAt,
      lastPurchaseTxnId: `admin_grant_${Date.now()}`,
    });
  }

  user.vipExpiresAt = expiresAt;
  await user.save();
  await invalidateVipCache(user._id.toString());

  res.json({ success: true, data: { expiresAt: expiresAt.toISOString() } });
};

export const revokeAdminVipMembership = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404).json({ success: false, error: 'User not found' });
    return;
  }

  await VipMembership.updateOne(
    { userId: user._id },
    { $set: { status: 'cancelled', expiresAt: new Date() } },
  );
  user.vipExpiresAt = null;
  await user.save();
  await invalidateVipCache(user._id.toString());

  res.json({ success: true });
};

export const getAdminVipStats = async (_req: Request, res: Response): Promise<void> => {
  const now = new Date();
  const [activeCount, expiredCount, todayUsage, plans] = await Promise.all([
    VipMembership.countDocuments({ status: 'active', expiresAt: { $gt: now } }),
    VipMembership.countDocuments({ status: 'expired' }),
    VipDailyMomentUsage.aggregate([
      { $group: { _id: null, totalRedeemed: { $sum: '$redeemedCount' } } },
    ]),
    getOrCreateVipPlans(),
  ]);

  const plan = plans[0];

  res.json({
    success: true,
    data: {
      activeMembers: activeCount,
      expiredMembers: expiredCount,
      totalFreeMomentsRedeemed: todayUsage[0]?.totalRedeemed ?? 0,
      defaultPlan: DEFAULT_VIP_PLAN,
      defaultPlans: DEFAULT_VIP_PLANS,
      currentPlan: {
        planId: plan.planId,
        priceInr: plan.priceInr,
        durationDays: plan.durationDays,
        isActive: plan.isActive,
      },
      plans,
    },
  });
};
