import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { CallHistory } from '../billing/call-history.model';
import { assignReferralCodeToUser } from '../user/referral.service';
import { checkDeletedStatus } from '../user/deleted-identity.service';
import { assertBd, loadStaffUserByAuth } from '../../middlewares/staff.middleware';
import { invalidateAdminCaches } from '../../config/redis';
import { Withdrawal } from '../creator/withdrawal.model';
import { logError, logInfo } from '../../utils/logger';
import { generateStaffPortalPassword, normalizeStaffPortalPassword } from '../../utils/staff-password';
import { StaffWalletLedger } from '../billing/staff-wallet-ledger.model';
import { AgencyRevenueDaily } from '../analytics/agency-revenue-daily.model';
import { utcDateKey } from '../analytics/analytics-aggregation.service';
import { buildAvatarUrls } from '../images/image-url';
import type { IImageAsset } from '../images/image-asset.schema';
import {
  countOnlineCreatorsForAgency,
  countOnlineByAgencyIds,
} from '../availability/presence-dashboard.service';

const BCRYPT_ROUNDS = 12;

import { AGENCY_ROLE_QUERY } from '../../utils/staff-roles';

function staffAvatarSmUrl(avatar: IImageAsset | null | undefined): string | null {
  const id = typeof avatar?.imageId === 'string' ? avatar.imageId.trim() : '';
  if (!id) return null;
  try {
    return buildAvatarUrls(id).sm;
  } catch {
    return null;
  }
}

function utcStartOfDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

async function sumLedgerCredits(match: Record<string, unknown>): Promise<number> {
  const agg = await StaffWalletLedger.aggregate([
    { $match: match },
    { $group: { _id: null, t: { $sum: '$amountCoins' } } },
  ]);
  return agg[0]?.t ?? 0;
}

export const getBdSummary = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertBd(req, res))) return;
    const bd = await loadStaffUserByAuth(req);
    if (!bd) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const bdOid = bd._id;
    const bdIds = await User.find({ bdId: bdOid, ...AGENCY_ROLE_QUERY }).distinct('_id');
    const [agencyCount, hostCount] = await Promise.all([
      Promise.resolve(bdIds.length),
      bdIds.length === 0
        ? Promise.resolve(0)
        : Creator.countDocuments({ assignedAgencyId: { $in: bdIds } }),
    ]);

    res.json({
      success: true,
      data: {
        bdId: bdOid.toString(),
        email: bd.email,
        displayName: bd.displayName ?? null,
        agencyCount,
        hostCount,
        mustChangePassword: bd.staffMustChangePassword === true,
      },
    });
  } catch (error) {
    logError('getBdSummary error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const listBdAgencies = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertBd(req, res))) return;
    const bd = await loadStaffUserByAuth(req);
    if (!bd) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const agencies = await User.find({ bdId: bd._id, ...AGENCY_ROLE_QUERY })
      .sort({ createdAt: -1 })
      .select('email displayName referralCode agencyDisabled staffMustChangePassword createdAt')
      .lean();

    const bdIds = agencies.map((b) => b._id);
    const hostAgg =
      bdIds.length === 0
        ? []
        : await Creator.aggregate<{ _id: mongoose.Types.ObjectId; c: number }>([
            { $match: { assignedAgencyId: { $in: bdIds } } },
            { $group: { _id: '$assignedAgencyId', c: { $sum: 1 } } },
          ]);
    const hostMap = new Map(hostAgg.map((h) => [h._id.toString(), h.c]));

    res.json({
      success: true,
      data: {
        agencies: agencies.map((b) => ({
          id: b._id.toString(),
          email: b.email,
          displayName: b.displayName ?? null,
          referralCode: b.referralCode ?? null,
          agencyDisabled: b.agencyDisabled ?? false,
          staffMustChangePassword: b.staffMustChangePassword === true,
          hostCount: hostMap.get(b._id.toString()) ?? 0,
          createdAt: b.createdAt,
        })),
      },
    });
  } catch (error) {
    logError('listBdAgencies error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/** Ledger-backed dashboard: revenue windows, BD breakdown, withdrawals (agency wallet only). */
export const getBdDashboard = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertBd(req, res))) return;
    const bd = await loadStaffUserByAuth(req);
    if (!bd) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const bdOid = bd._id;
    const now = new Date();
    const todayStart = utcStartOfDay(now);
    const d7 = new Date(now.getTime() - 7 * 86400000);
    const d30 = new Date(now.getTime() - 30 * 86400000);

    const agencies = await User.find({ bdId: bdOid, ...AGENCY_ROLE_QUERY })
      .select('_id email displayName referralCode agencyDisabled createdAt avatar')
      .sort({ createdAt: -1 })
      .lean();

    const bdIds = agencies.map((b) => b._id);
    const bdActive = agencies.filter((b) => !b.agencyDisabled).length;
    const bdInactive = agencies.length - bdActive;

    const [totalHosts, onlineHosts] = await Promise.all([
      bdIds.length === 0
        ? Promise.resolve(0)
        : Creator.countDocuments({ assignedAgencyId: { $in: bdIds } }),
      bdIds.length === 0
        ? Promise.resolve(0)
        : countOnlineCreatorsForAgency(bdOid.toString()),
    ]);

    let revenueToday = 0;
    let revenue7d = 0;
    let revenue30d = 0;

    const [rToday, r7, r30] = await Promise.all([
      sumLedgerCredits({
        staffUserId: bdOid,
        direction: 'credit',
        sourceType: 'call_settlement',
        createdAt: { $gte: todayStart },
      }),
      sumLedgerCredits({
        staffUserId: bdOid,
        direction: 'credit',
        sourceType: 'call_settlement',
        createdAt: { $gte: d7 },
      }),
      sumLedgerCredits({
        staffUserId: bdOid,
        direction: 'credit',
        sourceType: 'call_settlement',
        createdAt: { $gte: d30 },
      }),
    ]);
    revenueToday = rToday;
    revenue7d = r7;
    revenue30d = r30;

    if (process.env.USE_ANALYTICS_ROLLUPS === 'true') {
      const todayK = utcDateKey(now);
      const from7k = utcDateKey(d7);
      const from30k = utcDateKey(d30);
      const [tRow, roll7, roll30] = await Promise.all([
        AgencyRevenueDaily.findOne({ bdId: bdOid, dateKey: todayK })
          .select('totalSettlementCoins')
          .lean(),
        AgencyRevenueDaily.aggregate<{ t: number }>([
          { $match: { bdId: bdOid, dateKey: { $gte: from7k } } },
          { $group: { _id: null, t: { $sum: '$totalSettlementCoins' } } },
        ]),
        AgencyRevenueDaily.aggregate<{ t: number }>([
          { $match: { bdId: bdOid, dateKey: { $gte: from30k } } },
          { $group: { _id: null, t: { $sum: '$totalSettlementCoins' } } },
        ]),
      ]);
      const rollupReady = Boolean(tRow) || roll7.length > 0 || roll30.length > 0;
      if (rollupReady) {
        if (tRow && typeof tRow.totalSettlementCoins === 'number') {
          revenueToday = tRow.totalSettlementCoins;
        }
        if (roll7.length > 0) revenue7d = roll7[0].t;
        if (roll30.length > 0) revenue30d = roll30[0].t;
      }
    }

    const [pendingWithdrawals, completedWithdrawals, recentWithdrawals] = await Promise.all([
      Withdrawal.countDocuments({ staffUserId: bdOid, status: 'pending' }),
      Withdrawal.countDocuments({
        staffUserId: bdOid,
        status: { $in: ['paid', 'approved'] },
      }),
      Withdrawal.find({ staffUserId: bdOid })
        .sort({ createdAt: -1 })
        .limit(40)
        .select('amount status requestedAt processedAt createdAt')
        .lean(),
    ]);

    const bdIdStrings = bdIds.map((id) => id.toString());

    const [hostAggRows, ledgerBdRows, onlineByBd] = await Promise.all([
      bdIds.length === 0
        ? Promise.resolve([] as Array<{ _id: mongoose.Types.ObjectId; hostCount: number }>)
        : Creator.aggregate<{ _id: mongoose.Types.ObjectId; hostCount: number }>([
            { $match: { assignedAgencyId: { $in: bdIds } } },
            { $group: { _id: '$assignedAgencyId', hostCount: { $sum: 1 } } },
          ]),
      bdIds.length === 0
        ? Promise.resolve(
            [] as Array<{
              _id: { bdUserId?: mongoose.Types.ObjectId; staffUserId: mongoose.Types.ObjectId };
              coins: number;
              callIds: string[];
            }>
          )
        : StaffWalletLedger.aggregate<{
            _id: { bdUserId?: mongoose.Types.ObjectId; staffUserId: mongoose.Types.ObjectId };
            coins: number;
            callIds: string[];
          }>([
            {
              $match: {
                createdAt: { $gte: d7 },
                direction: 'credit',
                sourceType: 'call_settlement',
                $or: [
                  { staffUserId: { $in: bdIds } },
                  { staffUserId: bdOid, bdUserId: { $in: bdIds } },
                ],
              },
            },
            {
              $group: {
                _id: { bdUserId: '$bdUserId', staffUserId: '$staffUserId' },
                coins: { $sum: '$amountCoins' },
                callIds: { $addToSet: '$callId' },
              },
            },
          ]),
      bdIdStrings.length === 0
        ? Promise.resolve(new Map<string, number>())
        : countOnlineByAgencyIds(bdIdStrings),
    ]);

    const hostCountByBd = new Map(hostAggRows.map((r) => [r._id.toString(), r.hostCount]));
    const bdEarnById = new Map<string, number>();
    const agencyFromBdById = new Map<string, number>();
    const callsByBd = new Map<string, number>();
    const bdOidStr = bdOid.toString();

    for (const row of ledgerBdRows) {
      const staffId = row._id.staffUserId?.toString();
      const bdRef = row._id.bdUserId?.toString();
      const callCount = row.callIds.filter(Boolean).length;

      if (staffId && bdIdStrings.includes(staffId) && !bdRef) {
        bdEarnById.set(staffId, (bdEarnById.get(staffId) ?? 0) + row.coins);
        callsByBd.set(staffId, (callsByBd.get(staffId) ?? 0) + callCount);
      } else if (staffId === bdOidStr && bdRef) {
        agencyFromBdById.set(bdRef, (agencyFromBdById.get(bdRef) ?? 0) + row.coins);
        if (!callsByBd.has(bdRef)) {
          callsByBd.set(bdRef, callCount);
        }
      }
    }

    const bdAnalytics = agencies.map((b) => {
      const bid = b._id.toString();
      return {
        id: bid,
        email: b.email,
        displayName: b.displayName ?? null,
        referralCode: b.referralCode ?? null,
        agencyDisabled: b.agencyDisabled ?? false,
        avatarUrl: staffAvatarSmUrl(b.avatar as IImageAsset | null | undefined),
        hostCount: hostCountByBd.get(bid) ?? 0,
        onlineHostCount: onlineByBd.get(bid) ?? 0,
        callsLast7d: callsByBd.get(bid) ?? 0,
        bdEarningsCoinsLast7d: bdEarnById.get(bid) ?? 0,
        agencyRevenueFromBdLast7d: agencyFromBdById.get(bid) ?? 0,
      };
    });

    const sortedBds = [...bdAnalytics].sort(
      (a, b) =>
        b.bdEarningsCoinsLast7d - a.bdEarningsCoinsLast7d ||
        b.hostCount - a.hostCount ||
        b.agencyRevenueFromBdLast7d - a.agencyRevenueFromBdLast7d
    );
    const topBdsLeaderboard = sortedBds.slice(0, 5).map((row, i) => ({
      rank: i + 1,
      id: row.id,
      displayLabel: row.displayName || row.email,
      avatarUrl: row.avatarUrl ?? null,
      hostCount: row.hostCount,
      revenueGeneratedCoins: row.bdEarningsCoinsLast7d,
      commission5PctCoins: Math.round(row.bdEarningsCoinsLast7d * 0.05),
      activeHosts: row.onlineHostCount,
    }));

    const creatorsUnderAgency =
      bdIds.length === 0
        ? []
        : await Creator.find({ assignedAgencyId: { $in: bdIds } })
            .select('name userId assignedAgencyId avatar _id')
            .lean();

    const creatorByUserId = new Map(
      creatorsUnderAgency
        .filter((c) => c.userId)
        .map((c) => [c.userId!.toString(), c] as [string, (typeof creatorsUnderAgency)[0]])
    );
    const creatorMongoIds = creatorsUnderAgency.map((c) => c._id);
    const hostUserIds = creatorsUnderAgency
      .map((c) => c.userId)
      .filter((id): id is mongoose.Types.ObjectId => Boolean(id));

    let topHostsLeaderboard: Array<{
      rank: number;
      hostName: string;
      avatarUrl: string | null;
      bdName: string;
      minutes: number;
      calls: number;
      earningsCoins: number;
      incentiveCoins: number;
    }> = [];

    if (hostUserIds.length > 0) {
      const hostCallStats = await CallHistory.aggregate<{
        _id: mongoose.Types.ObjectId;
        minutes: number;
        calls: number;
        earnings: number;
      }>([
        {
          $match: {
            ownerRole: 'creator',
            ownerUserId: { $in: hostUserIds },
            createdAt: { $gte: d7 },
          },
        },
        {
          $group: {
            _id: '$ownerUserId',
            minutes: { $sum: { $divide: ['$durationSeconds', 60] } },
            calls: { $sum: 1 },
            earnings: { $sum: '$coinsEarned' },
          },
        },
        { $sort: { earnings: -1 } },
        { $limit: 5 },
      ]);

      const bdLabel = new Map(agencies.map((b) => [b._id.toString(), b.displayName || b.email || 'BD']));

      topHostsLeaderboard = hostCallStats.map((row, i) => {
        const creator = creatorByUserId.get(row._id.toString());
        const bid = creator?.assignedAgencyId?.toString();
        return {
          rank: i + 1,
          hostName: creator?.name ?? 'Host',
          avatarUrl: staffAvatarSmUrl(creator?.avatar as IImageAsset | null | undefined),
          bdName: bid ? bdLabel.get(bid) ?? '—' : '—',
          minutes: Math.round((row.minutes ?? 0) * 100) / 100,
          calls: row.calls ?? 0,
          earningsCoins: row.earnings ?? 0,
          incentiveCoins: 0,
        };
      });
    }

    const from14 = new Date(now);
    from14.setUTCDate(from14.getUTCDate() - 13);
    from14.setUTCHours(0, 0, 0, 0);
    const ledgerDaily = await StaffWalletLedger.aggregate<{ _id: string; coins: number }>([
      {
        $match: {
          staffUserId: bdOid,
          direction: 'credit',
          sourceType: 'call_settlement',
          createdAt: { $gte: from14 },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
          coins: { $sum: '$amountCoins' },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    const seriesMap = new Map(ledgerDaily.map((x) => [x._id, x.coins]));
    const revenueSeries14d: Array<{ date: string; coins: number }> = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(from14);
      d.setUTCDate(from14.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      revenueSeries14d.push({ date: key, coins: seriesMap.get(key) ?? 0 });
    }

    let activitySeries7d: Array<{ date: string; calls: number; minutes: number }> = [];
    if (creatorMongoIds.length > 0) {
      const act = await CallHistory.aggregate<{
        _id: string;
        calls: number;
        minutes: number;
      }>([
        {
          $match: {
            ownerRole: 'user',
            otherCreatorId: { $in: creatorMongoIds },
            createdAt: { $gte: d7 },
          },
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
            calls: { $sum: 1 },
            minutes: { $sum: { $divide: ['$durationSeconds', 60] } },
          },
        },
        { $sort: { _id: 1 } },
      ]);
      activitySeries7d = act.map((r) => ({
        date: r._id,
        calls: r.calls,
        minutes: Math.round((r.minutes ?? 0) * 100) / 100,
      }));
    }

    const [pendingWdAmount, processingWdAmount, paidWdAmount] = await Promise.all([
      Withdrawal.aggregate<{ t: number }>([
        { $match: { staffUserId: bdOid, status: 'pending' } },
        { $group: { _id: null, t: { $sum: '$amount' } } },
      ]),
      Withdrawal.aggregate<{ t: number }>([
        { $match: { staffUserId: bdOid, status: { $in: ['approved'] } } },
        { $group: { _id: null, t: { $sum: '$amount' } } },
      ]),
      Withdrawal.aggregate<{ t: number }>([
        { $match: { staffUserId: bdOid, status: 'paid' } },
        { $group: { _id: null, t: { $sum: '$amount' } } },
      ]),
    ]);

    const recentActivity = recentWithdrawals.slice(0, 12).map((w) => ({
      id: w._id.toString(),
      type: 'withdrawal' as const,
      message: `Withdrawal ${w.status}: ${w.amount.toLocaleString()} coins`,
      at: (w.requestedAt ?? w.createdAt).toISOString(),
    }));

    res.json({
      success: true,
      data: {
        bdId: bdOid.toString(),
        staffCoinsBalance: bd.staffCoinsBalance ?? 0,
        bdTotal: agencies.length,
        bdActive,
        bdInactive,
        totalHosts,
        onlineHosts,
        revenueCoins: {
          today: revenueToday,
          last7d: revenue7d,
          last30d: revenue30d,
        },
        withdrawals: {
          pendingCount: pendingWithdrawals,
          completedCount: completedWithdrawals,
          recent: recentWithdrawals.map((w) => ({
            id: w._id.toString(),
            amount: w.amount,
            status: w.status,
            requestedAt: w.requestedAt,
            processedAt: w.processedAt,
            createdAt: w.createdAt,
          })),
        },
        bdAnalytics,
        topBdsLeaderboard,
        topHostsLeaderboard,
        revenueSeries14d,
        activitySeries7d,
        recentActivity,
        payoutSummary: {
          pendingCoins: pendingWdAmount[0]?.t ?? 0,
          processingCoins: processingWdAmount[0]?.t ?? 0,
          paidCoins: paidWdAmount[0]?.t ?? 0,
          nextPayoutNote: 'Payout schedule is coordinated with platform finance.',
        },
      },
    });
  } catch (error) {
    logError('getBdDashboard error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const postBdStaffWithdrawalRequest = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!(await assertBd(req, res))) return;
    const bd = await loadStaffUserByAuth(req);
    if (!bd) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const amount = Number(req.body?.amount);
    const { createStaffWithdrawalRequest } = await import('../billing/staff-wallet-portal.service');
    const data = await createStaffWithdrawalRequest(bd._id, amount, {
      blockIfbdDisabled: true,
    });
    res.status(201).json({ success: true, data });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Internal server error';
    if (msg !== 'Internal server error') {
      res.status(400).json({ success: false, error: msg });
      return;
    }
    logError('postBdStaffWithdrawalRequest', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const createBdAgency = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertBd(req, res))) return;
    const bd = await loadStaffUserByAuth(req);
    if (!bd) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const email = String(req.body.email ?? '')
      .trim()
      .toLowerCase();
    const displayName =
      typeof req.body.displayName === 'string' ? req.body.displayName.trim().slice(0, 120) : undefined;

    if (!email) {
      res.status(400).json({ success: false, error: 'Email is required' });
      return;
    }

    const deletedStatus = await checkDeletedStatus({ email, phone: null });
    if (deletedStatus.isDeleted) {
      res.status(409).json({
        success: false,
        error: 'This email was previously removed and cannot be reused',
      });
      return;
    }

    const existing = await User.findOne({ email }).select('_id').lean();
    if (existing) {
      res.status(409).json({ success: false, error: 'Email already in use' });
      return;
    }

    const plainPassword = generateStaffPortalPassword(16);
    const passwordHash = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);

    const agency = await User.create({
      firebaseUid: `agency_${randomUUID().replace(/-/g, '')}`,
      email,
      role: 'agency',
      passwordHash,
      displayName: displayName || undefined,
      coins: 0,
      agencyDisabled: false,
      bdId: bd._id,
      staffMustChangePassword: true,
    });

    await assignReferralCodeToUser(agency);

    logInfo('BD created agency', { bdId: bd._id.toString(), agencyId: agency._id.toString(), email });

    invalidateAdminCaches('overview', 'users_analytics').catch(() => {});

    res.status(201).json({
      success: true,
      data: {
        id: agency._id.toString(),
        email: agency.email,
        displayName: agency.displayName ?? null,
        referralCode: agency.referralCode ?? null,
        generatedPassword: plainPassword,
      },
    });
  } catch (error) {
    logError('createBdAgency error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const patchBdProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertBd(req, res))) return;
    const bd = await loadStaffUserByAuth(req);
    if (!bd) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    if (typeof req.body.displayName !== 'string') {
      res.status(400).json({ success: false, error: 'displayName is required' });
      return;
    }

    const displayName = req.body.displayName.trim().slice(0, 120);
    if (!displayName) {
      res.status(400).json({ success: false, error: 'Display name cannot be empty' });
      return;
    }

    bd.displayName = displayName;
    await bd.save();

    res.json({
      success: true,
      data: { displayName },
    });
  } catch (error) {
    logError('patchBdProfile error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const changeBdPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertBd(req, res))) return;
    const bd = await loadStaffUserByAuth(req);
    if (!bd) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const bdWithHash = await User.findById(bd._id).select('+passwordHash');
    if (!bdWithHash?.passwordHash) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const currentPassword = normalizeStaffPortalPassword(req.body.currentPassword);
    const newPassword = normalizeStaffPortalPassword(req.body.newPassword);
    if (!currentPassword || !newPassword || newPassword.length < 8) {
      res.status(400).json({
        success: false,
        error: 'Current password and new password (at least 8 characters) are required',
      });
      return;
    }

    const match = await bcrypt.compare(currentPassword, bdWithHash.passwordHash);
    if (!match) {
      res.status(400).json({ success: false, error: 'Current password is incorrect' });
      return;
    }
    if (currentPassword === newPassword) {
      res.status(400).json({ success: false, error: 'Choose a password that is different from your current one' });
      return;
    }

    bdWithHash.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    bdWithHash.staffMustChangePassword = false;
    bdWithHash.markModified('passwordHash');
    await bdWithHash.save();

    logInfo('BD changed portal password', { bdId: bdWithHash._id.toString() });

    res.json({
      success: true,
      data: { mustChangePassword: false },
    });
  } catch (error) {
    logError('changeBdPassword error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
