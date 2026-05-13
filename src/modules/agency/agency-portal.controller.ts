import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { CallHistory } from '../billing/call-history.model';
import { assignReferralCodeToUser } from '../user/referral.service';
import { checkDeletedStatus } from '../user/deleted-identity.service';
import { assertAgency, loadStaffUserByAuth } from '../../middlewares/staff.middleware';
import { invalidateAdminCaches } from '../../config/redis';
import { emitToAdmin } from '../admin/admin.gateway';
import { Withdrawal } from '../creator/withdrawal.model';
import { logError, logInfo } from '../../utils/logger';
import { generateStaffPortalPassword } from '../../utils/staff-password';
import { StaffWalletLedger } from '../billing/staff-wallet-ledger.model';
import { AgencyRevenueDaily } from '../analytics/agency-revenue-daily.model';
import { utcDateKey } from '../analytics/analytics-aggregation.service';
import { buildAvatarUrls } from '../images/image-url';
import type { IImageAsset } from '../images/image-asset.schema';

const BCRYPT_ROUNDS = 12;

const BD_ROLE_QUERY = { $in: ['agent', 'bd'] as const };

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

export const getAgencySummary = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAgency(req, res))) return;
    const agency = await loadStaffUserByAuth(req);
    if (!agency) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const agencyOid = agency._id;
    const bdIds = await User.find({ agencyId: agencyOid, role: BD_ROLE_QUERY }).distinct('_id');
    const [bdCount, hostCount] = await Promise.all([
      Promise.resolve(bdIds.length),
      bdIds.length === 0
        ? Promise.resolve(0)
        : Creator.countDocuments({ assignedAgentId: { $in: bdIds } }),
    ]);

    res.json({
      success: true,
      data: {
        agencyId: agencyOid.toString(),
        email: agency.email,
        displayName: agency.displayName ?? null,
        bdCount,
        hostCount,
        mustChangePassword: agency.staffMustChangePassword === true,
      },
    });
  } catch (error) {
    logError('getAgencySummary error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const listAgencyBds = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAgency(req, res))) return;
    const agency = await loadStaffUserByAuth(req);
    if (!agency) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const bds = await User.find({ agencyId: agency._id, role: BD_ROLE_QUERY })
      .sort({ createdAt: -1 })
      .select('email displayName referralCode agentDisabled createdAt')
      .lean();

    const bdIds = bds.map((b) => b._id);
    const hostAgg =
      bdIds.length === 0
        ? []
        : await Creator.aggregate<{ _id: mongoose.Types.ObjectId; c: number }>([
            { $match: { assignedAgentId: { $in: bdIds } } },
            { $group: { _id: '$assignedAgentId', c: { $sum: 1 } } },
          ]);
    const hostMap = new Map(hostAgg.map((h) => [h._id.toString(), h.c]));

    res.json({
      success: true,
      data: {
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
    logError('listAgencyBds error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/** Ledger-backed dashboard: revenue windows, BD breakdown, withdrawals (agency wallet only). */
export const getAgencyDashboard = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAgency(req, res))) return;
    const agency = await loadStaffUserByAuth(req);
    if (!agency) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const agencyOid = agency._id;
    const now = new Date();
    const todayStart = utcStartOfDay(now);
    const d7 = new Date(now.getTime() - 7 * 86400000);
    const d30 = new Date(now.getTime() - 30 * 86400000);

    const bds = await User.find({ agencyId: agencyOid, role: BD_ROLE_QUERY })
      .select('_id email displayName referralCode agentDisabled createdAt avatar')
      .sort({ createdAt: -1 })
      .lean();

    const bdIds = bds.map((b) => b._id);
    const bdActive = bds.filter((b) => !b.agentDisabled).length;
    const bdInactive = bds.length - bdActive;

    const [totalHosts, onlineHosts] = await Promise.all([
      bdIds.length === 0
        ? Promise.resolve(0)
        : Creator.countDocuments({ assignedAgentId: { $in: bdIds } }),
      bdIds.length === 0
        ? Promise.resolve(0)
        : Creator.countDocuments({ assignedAgentId: { $in: bdIds }, isOnline: true }),
    ]);

    let revenueToday = 0;
    let revenue7d = 0;
    let revenue30d = 0;

    const [rToday, r7, r30] = await Promise.all([
      sumLedgerCredits({
        staffUserId: agencyOid,
        direction: 'credit',
        sourceType: 'call_settlement',
        createdAt: { $gte: todayStart },
      }),
      sumLedgerCredits({
        staffUserId: agencyOid,
        direction: 'credit',
        sourceType: 'call_settlement',
        createdAt: { $gte: d7 },
      }),
      sumLedgerCredits({
        staffUserId: agencyOid,
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
        AgencyRevenueDaily.findOne({ agencyId: agencyOid, dateKey: todayK })
          .select('totalSettlementCoins')
          .lean(),
        AgencyRevenueDaily.aggregate<{ t: number }>([
          { $match: { agencyId: agencyOid, dateKey: { $gte: from7k } } },
          { $group: { _id: null, t: { $sum: '$totalSettlementCoins' } } },
        ]),
        AgencyRevenueDaily.aggregate<{ t: number }>([
          { $match: { agencyId: agencyOid, dateKey: { $gte: from30k } } },
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
      Withdrawal.countDocuments({ staffUserId: agencyOid, status: 'pending' }),
      Withdrawal.countDocuments({
        staffUserId: agencyOid,
        status: { $in: ['paid', 'approved'] },
      }),
      Withdrawal.find({ staffUserId: agencyOid })
        .sort({ createdAt: -1 })
        .limit(40)
        .select('amount status requestedAt processedAt createdAt')
        .lean(),
    ]);

    const bdAnalytics = await Promise.all(
      bds.map(async (b) => {
        const bid = b._id;
        const [hostCount, onlineHostCount, bdEarn7d, agencyFromBd7d, callIds7d] =
          await Promise.all([
            Creator.countDocuments({ assignedAgentId: bid }),
            Creator.countDocuments({ assignedAgentId: bid, isOnline: true }),
            sumLedgerCredits({
              staffUserId: bid,
              direction: 'credit',
              sourceType: 'call_settlement',
              createdAt: { $gte: d7 },
            }),
            sumLedgerCredits({
              staffUserId: agencyOid,
              direction: 'credit',
              sourceType: 'call_settlement',
              bdUserId: bid,
              createdAt: { $gte: d7 },
            }),
            StaffWalletLedger.distinct('callId', {
              bdUserId: bid,
              direction: 'credit',
              sourceType: 'call_settlement',
              createdAt: { $gte: d7 },
              callId: { $exists: true, $nin: [null, ''] },
            }),
          ]);

        return {
          id: bid.toString(),
          email: b.email,
          displayName: b.displayName ?? null,
          referralCode: b.referralCode ?? null,
          agentDisabled: b.agentDisabled ?? false,
          avatarUrl: staffAvatarSmUrl(b.avatar as IImageAsset | null | undefined),
          hostCount,
          onlineHostCount,
          callsLast7d: callIds7d.filter(Boolean).length,
          bdEarningsCoinsLast7d: bdEarn7d,
          agencyRevenueFromBdLast7d: agencyFromBd7d,
        };
      })
    );

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
        : await Creator.find({ assignedAgentId: { $in: bdIds } })
            .select('name userId assignedAgentId avatar _id')
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

      const bdLabel = new Map(bds.map((b) => [b._id.toString(), b.displayName || b.email || 'BD']));

      topHostsLeaderboard = hostCallStats.map((row, i) => {
        const creator = creatorByUserId.get(row._id.toString());
        const bid = creator?.assignedAgentId?.toString();
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
          staffUserId: agencyOid,
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
        { $match: { staffUserId: agencyOid, status: 'pending' } },
        { $group: { _id: null, t: { $sum: '$amount' } } },
      ]),
      Withdrawal.aggregate<{ t: number }>([
        { $match: { staffUserId: agencyOid, status: { $in: ['approved'] } } },
        { $group: { _id: null, t: { $sum: '$amount' } } },
      ]),
      Withdrawal.aggregate<{ t: number }>([
        { $match: { staffUserId: agencyOid, status: 'paid' } },
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
        agencyId: agencyOid.toString(),
        staffCoinsBalance: agency.staffCoinsBalance ?? 0,
        bdTotal: bds.length,
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
    logError('getAgencyDashboard error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const postAgencyStaffWithdrawalRequest = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!(await assertAgency(req, res))) return;
    const agency = await loadStaffUserByAuth(req);
    if (!agency) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const amount = Number(req.body?.amount);
    const { createStaffWithdrawalRequest } = await import('../billing/staff-wallet-portal.service');
    const data = await createStaffWithdrawalRequest(agency._id, amount, {
      blockIfAgencyDisabled: true,
    });
    res.status(201).json({ success: true, data });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Internal server error';
    if (msg !== 'Internal server error') {
      res.status(400).json({ success: false, error: msg });
      return;
    }
    logError('postAgencyStaffWithdrawalRequest', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const createAgencyBd = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAgency(req, res))) return;
    const agency = await loadStaffUserByAuth(req);
    if (!agency) {
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

    const bd = await User.create({
      firebaseUid: `bd_${randomUUID().replace(/-/g, '')}`,
      email,
      role: 'bd',
      passwordHash,
      displayName: displayName || undefined,
      coins: 0,
      agentDisabled: false,
      agencyId: agency._id,
      staffMustChangePassword: true,
    });

    await assignReferralCodeToUser(bd);

    logInfo('Agency created BD', { agencyId: agency._id.toString(), bdId: bd._id.toString(), email });

    invalidateAdminCaches('overview', 'users_analytics').catch(() => {});

    res.status(201).json({
      success: true,
      data: {
        id: bd._id.toString(),
        email: bd.email,
        displayName: bd.displayName ?? null,
        referralCode: bd.referralCode ?? null,
        generatedPassword: plainPassword,
      },
    });
  } catch (error) {
    logError('createAgencyBd error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const patchAgencyProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAgency(req, res))) return;
    const agency = await loadStaffUserByAuth(req);
    if (!agency) {
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

    agency.displayName = displayName;
    await agency.save();

    res.json({
      success: true,
      data: { displayName },
    });
  } catch (error) {
    logError('patchAgencyProfile error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const changeAgencyPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAgency(req, res))) return;
    if (!req.auth?.firebaseUid) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const agency = await User.findOne({ firebaseUid: req.auth.firebaseUid }).select('+passwordHash');
    if (!agency || !agency.passwordHash) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const currentPassword = String(req.body.currentPassword ?? '');
    const newPassword = String(req.body.newPassword ?? '');
    if (!currentPassword || !newPassword || newPassword.length < 8) {
      res.status(400).json({
        success: false,
        error: 'Current password and new password (at least 8 characters) are required',
      });
      return;
    }

    const match = await bcrypt.compare(currentPassword, agency.passwordHash);
    if (!match) {
      res.status(401).json({ success: false, error: 'Current password is incorrect' });
      return;
    }
    if (currentPassword === newPassword) {
      res.status(400).json({ success: false, error: 'Choose a password that is different from your current one' });
      return;
    }

    agency.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    agency.staffMustChangePassword = false;
    await agency.save();

    logInfo('Agency changed portal password', { agencyId: agency._id.toString() });

    res.json({
      success: true,
      data: { mustChangePassword: false },
    });
  } catch (error) {
    logError('changeAgencyPassword error', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
