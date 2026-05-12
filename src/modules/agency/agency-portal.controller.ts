import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { assignReferralCodeToUser } from '../user/referral.service';
import { assertAgency, loadStaffUserByAuth } from '../../middlewares/staff.middleware';
import { invalidateAdminCaches } from '../../config/redis';
import { emitToAdmin } from '../admin/admin.gateway';
import { Withdrawal } from '../creator/withdrawal.model';
import { logError, logInfo } from '../../utils/logger';
import { generateStaffPortalPassword } from '../../utils/staff-password';
import { StaffWalletLedger } from '../billing/staff-wallet-ledger.model';
import { AgencyRevenueDaily } from '../analytics/agency-revenue-daily.model';
import { utcDateKey } from '../analytics/analytics-aggregation.service';

const BCRYPT_ROUNDS = 12;

const BD_ROLE_QUERY = { $in: ['agent', 'bd'] as const };

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
      .select('_id email displayName referralCode agentDisabled createdAt')
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
          hostCount,
          onlineHostCount,
          callsLast7d: callIds7d.filter(Boolean).length,
          bdEarningsCoinsLast7d: bdEarn7d,
          agencyRevenueFromBdLast7d: agencyFromBd7d,
        };
      })
    );

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
    if (agency.agencyDisabled) {
      res.status(403).json({
        success: false,
        error: 'Agency is disabled — new payout requests are blocked',
      });
      return;
    }

    const amount = Number(req.body?.amount);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const number = typeof req.body?.number === 'string' ? req.body.number.trim() : '';
    const upi = typeof req.body?.upi === 'string' ? req.body.upi.trim() : '';
    const accountNumber =
      typeof req.body?.accountNumber === 'string' ? req.body.accountNumber.trim() : '';
    const ifsc = typeof req.body?.ifsc === 'string' ? req.body.ifsc.trim() : '';

    if (!Number.isFinite(amount) || amount < 1) {
      res.status(400).json({ success: false, error: 'Invalid amount' });
      return;
    }

    const w = await Withdrawal.create({
      staffUserId: agency._id,
      amount: Math.floor(amount),
      status: 'pending',
      requestedAt: new Date(),
      name: name || undefined,
      number: number || undefined,
      upi: upi || undefined,
      accountNumber: accountNumber || undefined,
      ifsc: ifsc || undefined,
    });

    emitToAdmin('withdrawal:requested', {
      withdrawalId: w._id.toString(),
      staffUserId: agency._id.toString(),
      amount: w.amount,
    });

    invalidateAdminCaches('overview').catch(() => {});

    res.status(201).json({
      success: true,
      data: { id: w._id.toString(), amount: w.amount, status: w.status },
    });
  } catch (error) {
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
