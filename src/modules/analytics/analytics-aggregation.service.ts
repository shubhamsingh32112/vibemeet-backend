import mongoose from 'mongoose';
import { User } from '../user/user.model';
import { StaffWalletLedger } from '../billing/staff-wallet-ledger.model';
import { Withdrawal } from '../creator/withdrawal.model';
import { AgencyRevenueDaily } from './agency-revenue-daily.model';
import { BdRevenueDaily } from './bd-revenue-daily.model';
import { PlatformRevenueDaily } from './platform-revenue-daily.model';
import { logInfo } from '../../utils/logger';

export function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utcDayBounds(dateKey: string): { start: Date; end: Date } {
  const start = new Date(`${dateKey}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 86400_000);
  return { start, end };
}

/**
 * Rebuild pre-aggregates for a single UTC calendar day. Idempotent (upsert by natural keys).
 *
 * Index intent: rollups read by `{ agencyId, dateKey }` / `{ bdId, dateKey }` / `{ dateKey }` — see schema index comments.
 */
export async function rebuildAnalyticsUtcDay(dateKey: string): Promise<void> {
  const { start, end } = utcDayBounds(dateKey);

  const ledgerMatch = {
    createdAt: { $gte: start, $lt: end },
    direction: 'credit' as const,
    sourceType: 'call_settlement' as const,
  };

  const [platformAgg] = await StaffWalletLedger.aggregate<{ t: number }>([
    { $match: ledgerMatch },
    { $group: { _id: null, t: { $sum: '$amountCoins' } } },
  ]);
  const platformSettlement = platformAgg?.t ?? 0;
  const platformCallIds = await StaffWalletLedger.distinct('callId', {
    ...ledgerMatch,
    callId: { $exists: true, $nin: [null, ''] },
  });

  const withdrawalSum = await Withdrawal.aggregate<{ t: number }>([
    {
      $match: {
        staffUserId: { $exists: true, $ne: null },
        status: { $in: ['approved', 'paid'] },
        processedAt: { $gte: start, $lt: end },
      },
    },
    { $group: { _id: null, t: { $sum: '$amount' } } },
  ]);
  const platformWd = withdrawalSum[0]?.t ?? 0;

  await PlatformRevenueDaily.findOneAndUpdate(
    { dateKey },
    {
      $set: {
        totalSettlementCoins: platformSettlement,
        totalWithdrawalsCoins: platformWd,
        totalCalls: platformCallIds.filter(Boolean).length,
      },
    },
    { upsert: true, new: true }
  );

  const agencies = await User.find({ role: 'agency' }).select('_id').lean();
  for (const a of agencies) {
    const aid = a._id as mongoose.Types.ObjectId;
    const [ag] = await StaffWalletLedger.aggregate<{ t: number }>([
      { $match: { ...ledgerMatch, staffUserId: aid } },
      { $group: { _id: null, t: { $sum: '$amountCoins' } } },
    ]);
    const calls = await StaffWalletLedger.distinct('callId', {
      ...ledgerMatch,
      staffUserId: aid,
      callId: { $exists: true, $nin: [null, ''] },
    });
    const wdAg = await Withdrawal.aggregate<{ t: number }>([
      {
        $match: {
          staffUserId: aid,
          status: { $in: ['approved', 'paid'] },
          processedAt: { $gte: start, $lt: end },
        },
      },
      { $group: { _id: null, t: { $sum: '$amount' } } },
    ]);

    await AgencyRevenueDaily.findOneAndUpdate(
      { agencyId: aid, dateKey },
      {
        $set: {
          totalSettlementCoins: ag?.t ?? 0,
          totalWithdrawalsCoins: wdAg[0]?.t ?? 0,
          totalCalls: calls.filter(Boolean).length,
        },
      },
      { upsert: true, new: true }
    );
  }

  const bds = await User.find({ role: { $in: ['agent', 'bd'] } })
    .select('_id agencyId')
    .lean();
  for (const b of bds) {
    const bid = b._id as mongoose.Types.ObjectId;
    const [bdAgg] = await StaffWalletLedger.aggregate<{ t: number }>([
      { $match: { ...ledgerMatch, staffUserId: bid } },
      { $group: { _id: null, t: { $sum: '$amountCoins' } } },
    ]);
    const bdCalls = await StaffWalletLedger.distinct('callId', {
      ...ledgerMatch,
      staffUserId: bid,
      callId: { $exists: true, $nin: [null, ''] },
    });

    await BdRevenueDaily.findOneAndUpdate(
      { bdId: bid, dateKey },
      {
        $set: {
          agencyId: (b.agencyId as mongoose.Types.ObjectId | undefined) ?? null,
          totalSettlementCoins: bdAgg?.t ?? 0,
          totalCalls: bdCalls.filter(Boolean).length,
        },
      },
      { upsert: true, new: true }
    );
  }

  logInfo('Analytics rollup rebuilt for UTC day', { dateKey });
}

export async function rebuildAnalyticsDateRange(fromKey: string, toKey: string): Promise<number> {
  let n = 0;
  const cur = new Date(`${fromKey}T00:00:00.000Z`);
  const endLimit = new Date(`${toKey}T00:00:00.000Z`);
  while (cur <= endLimit) {
    const key = utcDateKey(cur);
    await rebuildAnalyticsUtcDay(key);
    n++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return n;
}
