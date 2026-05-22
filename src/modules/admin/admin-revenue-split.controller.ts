import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { CallHistory } from '../billing/call-history.model';
import { StaffWalletLedger } from '../billing/staff-wallet-ledger.model';
import { User } from '../user/user.model';
import { assertAdmin } from '../../middlewares/staff.middleware';
import { logError } from '../../utils/logger';
import { isBdRole, isAgencyRole } from '../../utils/staff-roles';
import {
  getSplitIndependentHostPct,
  getSplitWithStaffPct,
} from './admin-revenue-split.constants';

function utcStartOfDaysAgo(days: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d;
}

export const getRevenueSplitSummary = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const days = Math.min(365, Math.max(1, parseInt(String(req.query.days ?? '30'), 10) || 30));
    const from = utcStartOfDaysAgo(days);

    const userCallMatch = { ownerRole: 'user' as const, createdAt: { $gte: from } };

    const [userSpendAgg, hostEarnAgg, staffLedgerRows] = await Promise.all([
      CallHistory.aggregate<{ _id: null; total: number }>([
        { $match: userCallMatch },
        { $group: { _id: null, total: { $sum: '$coinsDeducted' } } },
      ]),
      CallHistory.aggregate<{ _id: null; total: number }>([
        { $match: { ownerRole: 'creator', createdAt: { $gte: from } } },
        { $group: { _id: null, total: { $sum: '$coinsEarned' } } },
      ]),
      StaffWalletLedger.aggregate<{
        _id: mongoose.Types.ObjectId;
        total: number;
      }>([
        {
          $match: {
            direction: 'credit',
            sourceType: 'call_settlement',
            createdAt: { $gte: from },
          },
        },
        { $group: { _id: '$staffUserId', total: { $sum: '$amountCoins' } } },
      ]),
    ]);

    const totalCallRevenue = userSpendAgg[0]?.total ?? 0;
    const totalHostRevenue = hostEarnAgg[0]?.total ?? 0;

    let totalBdRevenue = 0;
    let totalAgencyRevenue = 0;

    if (staffLedgerRows.length > 0) {
      const staffIds = staffLedgerRows.map((r) => r._id);
      const staffUsers = await User.find({ _id: { $in: staffIds } })
        .select('_id role')
        .lean();
      const roleById = new Map(staffUsers.map((u) => [u._id.toString(), u.role]));
      for (const row of staffLedgerRows) {
        const role = roleById.get(row._id.toString());
        if (isBdRole(role)) totalBdRevenue += row.total;
        else if (isAgencyRole(role)) totalAgencyRevenue += row.total;
      }
    }

    const totalPlatformRevenue = Math.max(
      0,
      totalCallRevenue - totalHostRevenue - totalBdRevenue - totalAgencyRevenue
    );

    const pctCoins = (pct: number) => Math.floor((totalCallRevenue * pct) / 100);

    const [splitWithStaffPct, splitIndependentPct] = await Promise.all([
      getSplitWithStaffPct(),
      getSplitIndependentHostPct(),
    ]);

    const scenarioWithStaff = {
      key: 'with_agency_and_bd',
      label: 'Host with agency & BD (policy %)',
      slices: splitWithStaffPct.map((s) => ({
        ...s,
        coins: pctCoins(s.pct),
      })),
      platformCoins: pctCoins(
        splitWithStaffPct.find((s) => s.key === 'platform')?.pct ?? 0
      ),
    };

    const scenarioIndependent = {
      key: 'independent_host',
      label: 'Host without agency or BD (policy %)',
      slices: splitIndependentPct.map((s) => ({
        ...s,
        coins: pctCoins(s.pct),
      })),
      platformCoins: pctCoins(
        splitIndependentPct.find((s) => s.key === 'platform')?.pct ?? 0
      ),
    };

    res.json({
      success: true,
      data: {
        rangeDays: days,
        from: from.toISOString(),
        inrPerCoin: 0.8,
        inrPerCoinNote: '₹0.80 per coin (80 paise) — display conversion only',
        actual: {
          totalRevenue: totalCallRevenue,
          hostRevenue: totalHostRevenue,
          bdRevenue: totalBdRevenue,
          agencyRevenue: totalAgencyRevenue,
          platformRevenue: totalPlatformRevenue,
        },
        scenarios: {
          withAgencyAndBd: scenarioWithStaff,
          independentHost: scenarioIndependent,
        },
        combinedPlatformCoins: {
          actualSettled: totalPlatformRevenue,
          policyWithStaff: scenarioWithStaff.platformCoins,
          policyIndependentHost: scenarioIndependent.platformCoins,
        },
      },
    });
  } catch (error) {
    logError('getRevenueSplitSummary', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
