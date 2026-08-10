import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { CreatorReferralEdge } from './creator-referral-edge.model';
import {
  getOrCreateCreatorReferralConfig,
  updateCreatorReferralConfig,
} from './creator-referral-config.model';
import { CREATOR_REFERRAL_COINS_MAX } from './creator-referral.config';
import { reconcileUnpaidCreatorReferrals } from './creator-referral-reward.service';
import { assignCreatorReferralCode } from '../user/referral.service';
import { assertAdmin } from '../../middlewares/staff.middleware';
import { logError } from '../../utils/logger';

function displayNameFromUser(u: {
  username?: string | null;
  email?: string | null;
}): string {
  if (u.username && u.username.trim()) return u.username.trim();
  if (u.email) {
    const local = u.email.split('@')[0]?.trim();
    if (local) return local;
  }
  return 'User';
}

function stagePaid(edge: {
  creatorRewardedAt?: Date | null;
  attachRewardedAt?: Date | null;
  telegramRewardedAt?: Date | null;
  purchaseRewardedAt?: Date | null;
}): {
  attachRewarded: boolean;
  telegramRewarded: boolean;
  purchaseRewarded: boolean;
  legacy: boolean;
} {
  const legacy = !!edge.creatorRewardedAt;
  return {
    legacy,
    attachRewarded: legacy || !!edge.attachRewardedAt,
    telegramRewarded: legacy || !!edge.telegramRewardedAt,
    purchaseRewarded: legacy || !!edge.purchaseRewardedAt,
  };
}

function edgeCoinsEarned(edge: {
  creatorRewardedAt?: Date | null;
  creatorRewardCoins?: number | null;
  attachRewardCoins?: number | null;
  telegramRewardCoins?: number | null;
  purchaseRewardCoins?: number | null;
}): number {
  if (edge.creatorRewardedAt) {
    return edge.creatorRewardCoins ?? 0;
  }
  return (
    (edge.attachRewardCoins ?? 0) +
    (edge.telegramRewardCoins ?? 0) +
    (edge.purchaseRewardCoins ?? 0)
  );
}

function parseStageCoins(
  body: Record<string, unknown>,
  key: string
): { ok: true; value?: number } | { ok: false; error: string } {
  if (body[key] === undefined || body[key] === null) {
    return { ok: true, value: undefined };
  }
  const n = Number(body[key]);
  if (!Number.isFinite(n) || n < 1 || n > CREATOR_REFERRAL_COINS_MAX) {
    return {
      ok: false,
      error: `${key} must be 1–${CREATOR_REFERRAL_COINS_MAX}`,
    };
  }
  return { ok: true, value: Math.floor(n) };
}

/**
 * GET /user/creator-referrals — creator's own affiliate progress.
 */
export const getMyCreatorReferrals = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    if (user.role !== 'creator' && user.role !== 'admin' && user.role !== 'super_admin') {
      res.status(403).json({ success: false, error: 'Creators only' });
      return;
    }

    let referralCode = user.referralCode ?? null;
    try {
      referralCode = await assignCreatorReferralCode(user);
    } catch {
      // keep existing
    }

    const cfg = await getOrCreateCreatorReferralConfig();
    const edges = await CreatorReferralEdge.find({ creatorUserId: user._id })
      .sort({ createdAt: -1 })
      .lean();

    const referredIds = edges.map((e) => e.referredUserId);
    const referredUsers =
      referredIds.length > 0
        ? await User.find({ _id: { $in: referredIds } })
            .select('_id username email')
            .lean()
        : [];
    const userById = new Map(referredUsers.map((u) => [u._id.toString(), u] as const));

    let attachPaidCount = 0;
    let telegramPaidCount = 0;
    let purchasePaidCount = 0;
    let coinsEarned = 0;

    const referrals = edges.map((edge) => {
      const uid = edge.referredUserId.toString();
      const referred = userById.get(uid);
      const paid = stagePaid(edge);
      if (paid.attachRewarded) attachPaidCount += 1;
      if (paid.telegramRewarded) telegramPaidCount += 1;
      if (paid.purchaseRewarded) purchasePaidCount += 1;
      coinsEarned += edgeCoinsEarned(edge);
      return {
        userId: uid,
        name: referred ? displayNameFromUser(referred) : 'User',
        attachRewarded: paid.attachRewarded,
        attachRewardedAt: edge.attachRewardedAt?.toISOString?.() ?? null,
        attachRewardCoins: edge.attachRewardCoins ?? null,
        telegramJoined: !!edge.telegramJoinedAt || paid.telegramRewarded,
        telegramJoinedAt: edge.telegramJoinedAt?.toISOString?.() ?? null,
        telegramRewarded: paid.telegramRewarded,
        telegramRewardedAt: edge.telegramRewardedAt?.toISOString?.() ?? null,
        telegramRewardCoins: edge.telegramRewardCoins ?? null,
        purchaseRewarded: paid.purchaseRewarded,
        purchaseRewardedAt: edge.purchaseRewardedAt?.toISOString?.() ?? null,
        purchaseRewardCoins: edge.purchaseRewardCoins ?? null,
        joinedAt: edge.createdAt?.toISOString?.() ?? new Date().toISOString(),
      };
    });

    res.json({
      success: true,
      data: {
        referralCode,
        enabled: cfg.enabled,
        attachCoins: cfg.attachCoins,
        telegramCoins: cfg.telegramCoins,
        purchaseCoins: cfg.purchaseCoins,
        summary: {
          referredCount: edges.length,
          attachPaidCount,
          telegramPaidCount,
          purchasePaidCount,
          coinsEarned,
        },
        referrals,
      },
    });
  } catch (error) {
    logError('getMyCreatorReferrals', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getCreatorReferralConfigAdmin = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const cfg = await getOrCreateCreatorReferralConfig();
    res.json({ success: true, data: cfg });
  } catch (error) {
    logError('getCreatorReferralConfigAdmin', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const updateCreatorReferralConfigAdmin = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const enabled =
      typeof body.enabled === 'boolean' ? (body.enabled as boolean) : undefined;

    const attach = parseStageCoins(body, 'attachCoins');
    if (!attach.ok) {
      res.status(400).json({ success: false, error: attach.error });
      return;
    }
    const telegram = parseStageCoins(body, 'telegramCoins');
    if (!telegram.ok) {
      res.status(400).json({ success: false, error: telegram.error });
      return;
    }
    const purchase = parseStageCoins(body, 'purchaseCoins');
    if (!purchase.ok) {
      res.status(400).json({ success: false, error: purchase.error });
      return;
    }

    const cfg = await updateCreatorReferralConfig({
      enabled,
      attachCoins: attach.value,
      telegramCoins: telegram.value,
      purchaseCoins: purchase.value,
    });
    if (cfg.enabled) {
      void reconcileUnpaidCreatorReferrals(200).catch(() => {});
    }
    res.json({ success: true, data: cfg });
  } catch (error) {
    logError('updateCreatorReferralConfigAdmin', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/**
 * GET /admin/creator-referrals — paginated creators with affiliate stats.
 */
export const listCreatorReferralsAdmin = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const search =
      typeof req.query.search === 'string' ? req.query.search.trim() : '';

    const creatorFilter: Record<string, unknown> = {};
    if (search) {
      creatorFilter.name = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    }

    const total = await Creator.countDocuments(creatorFilter);
    const creators = await Creator.find(creatorFilter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('userId name isDisabled')
      .lean();

    const userIds = creators.map((c) => c.userId);
    const users =
      userIds.length > 0
        ? await User.find({ _id: { $in: userIds } })
            .select('_id referralCode username email')
            .lean()
        : [];
    const userById = new Map(users.map((u) => [u._id.toString(), u] as const));

    const stats =
      userIds.length > 0
        ? await CreatorReferralEdge.aggregate([
            { $match: { creatorUserId: { $in: userIds } } },
            {
              $group: {
                _id: '$creatorUserId',
                referredCount: { $sum: 1 },
                attachPaid: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $ne: ['$creatorRewardedAt', null] },
                          { $ne: ['$attachRewardedAt', null] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                telegramPaid: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $ne: ['$creatorRewardedAt', null] },
                          { $ne: ['$telegramRewardedAt', null] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                purchasePaid: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $ne: ['$creatorRewardedAt', null] },
                          { $ne: ['$purchaseRewardedAt', null] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                coinsPaid: {
                  $sum: {
                    $cond: [
                      { $ne: ['$creatorRewardedAt', null] },
                      { $ifNull: ['$creatorRewardCoins', 0] },
                      {
                        $add: [
                          { $ifNull: ['$attachRewardCoins', 0] },
                          { $ifNull: ['$telegramRewardCoins', 0] },
                          { $ifNull: ['$purchaseRewardCoins', 0] },
                        ],
                      },
                    ],
                  },
                },
              },
            },
          ])
        : [];
    const statsById = new Map(stats.map((s) => [s._id.toString(), s] as const));

    const rows = creators.map((c) => {
      const uid = c.userId.toString();
      const u = userById.get(uid);
      const s = statsById.get(uid);
      return {
        creatorId: c._id.toString(),
        creatorUserId: uid,
        name: c.name,
        isDisabled: c.isDisabled === true,
        referralCode: u?.referralCode ?? null,
        referredCount: s?.referredCount ?? 0,
        attachPaid: s?.attachPaid ?? 0,
        telegramPaid: s?.telegramPaid ?? 0,
        purchasePaid: s?.purchasePaid ?? 0,
        coinsPaid: s?.coinsPaid ?? 0,
      };
    });

    res.json({
      success: true,
      data: {
        rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit) || 1,
        },
      },
    });
  } catch (error) {
    logError('listCreatorReferralsAdmin', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/**
 * GET /admin/creator-referrals/:creatorUserId — detail for one creator.
 */
export const getCreatorReferralDetailAdmin = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const rawId = req.params.creatorUserId;
    if (!rawId || !mongoose.Types.ObjectId.isValid(rawId)) {
      res.status(400).json({ success: false, error: 'Invalid creatorUserId' });
      return;
    }
    const creatorUserId = new mongoose.Types.ObjectId(rawId);

    const user = await User.findById(creatorUserId)
      .select('_id referralCode username email role')
      .lean();
    if (!user || user.role !== 'creator') {
      res.status(404).json({ success: false, error: 'Creator not found' });
      return;
    }

    const creator = await Creator.findOne({ userId: creatorUserId })
      .select('_id name isDisabled')
      .lean();

    const edges = await CreatorReferralEdge.find({ creatorUserId })
      .sort({ createdAt: -1 })
      .lean();

    const referredIds = edges.map((e) => e.referredUserId);
    const referredUsers =
      referredIds.length > 0
        ? await User.find({ _id: { $in: referredIds } })
            .select('_id username email createdAt')
            .lean()
        : [];
    const userById = new Map(referredUsers.map((u) => [u._id.toString(), u] as const));

    const referrals = edges.map((edge) => {
      const uid = edge.referredUserId.toString();
      const referred = userById.get(uid);
      const paid = stagePaid(edge);
      return {
        userId: uid,
        name: referred ? displayNameFromUser(referred) : 'User',
        email: referred?.email ?? null,
        referralCodeUsed: edge.referralCodeUsed,
        attachRewarded: paid.attachRewarded,
        attachRewardedAt: edge.attachRewardedAt?.toISOString?.() ?? null,
        attachRewardCoins: edge.attachRewardCoins ?? null,
        telegramJoined: !!edge.telegramJoinedAt || paid.telegramRewarded,
        telegramJoinedAt: edge.telegramJoinedAt?.toISOString?.() ?? null,
        telegramRewarded: paid.telegramRewarded,
        telegramRewardedAt: edge.telegramRewardedAt?.toISOString?.() ?? null,
        telegramRewardCoins: edge.telegramRewardCoins ?? null,
        purchaseRewarded: paid.purchaseRewarded,
        purchaseRewardedAt: edge.purchaseRewardedAt?.toISOString?.() ?? null,
        purchaseRewardCoins: edge.purchaseRewardCoins ?? null,
        coinsEarned: edgeCoinsEarned(edge),
        joinedAt: edge.createdAt?.toISOString?.() ?? null,
      };
    });

    const cfg = await getOrCreateCreatorReferralConfig();

    res.json({
      success: true,
      data: {
        creatorUserId: creatorUserId.toString(),
        creatorId: creator?._id?.toString() ?? null,
        name: creator?.name ?? displayNameFromUser(user),
        isDisabled: creator?.isDisabled === true,
        referralCode: user.referralCode ?? null,
        attachCoins: cfg.attachCoins,
        telegramCoins: cfg.telegramCoins,
        purchaseCoins: cfg.purchaseCoins,
        configEnabled: cfg.enabled,
        referrals,
      },
    });
  } catch (error) {
    logError('getCreatorReferralDetailAdmin', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
