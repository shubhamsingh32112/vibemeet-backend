import mongoose from 'mongoose';
import { User, type IUser } from '../user/user.model';
import { resolveStaffCommissionBps } from '../payment/commission-resolve.service';
import { isAgencyRole, isBdRole } from '../../utils/staff-roles';
import { Withdrawal } from '../creator/withdrawal.model';
import { StaffWalletLedger } from './staff-wallet-ledger.model';
import { StaffPayoutAccount } from './staff-payout-account.model';
import { invalidateAdminCaches } from '../../config/redis';
import { emitToAdmin } from '../admin/admin.gateway';
import { MIN_STAFF_WITHDRAWAL_COINS } from '../creator/creator-withdrawal.constants';

export { MIN_STAFF_WITHDRAWAL_COINS };
const STAFF_WITHDRAWAL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export type PayoutAccountInput = {
  accountHolderName: string;
  accountNumber?: string;
  ifsc?: string;
  upi?: string;
  phone?: string;
};

export type PayoutAccountDto = {
  accountHolderName: string;
  accountNumber: string | null;
  ifsc: string | null;
  upi: string | null;
  phone: string | null;
  isComplete: boolean;
  updatedAt: string;
};

function maskAccountNumber(value?: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\s/g, '');
  if (digits.length <= 4) return digits;
  return `${'•'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

function maskUpi(value?: string | null): string | null {
  if (!value) return null;
  const at = value.indexOf('@');
  if (at <= 1) return value;
  return `${value[0]}***${value.slice(at)}`;
}

export function serializePayoutAccount(
  doc: {
    accountHolderName: string;
    accountNumber?: string;
    ifsc?: string;
    upi?: string;
    phone?: string;
    updatedAt?: Date;
  },
  opts?: { mask?: boolean },
): PayoutAccountDto {
  const mask = opts?.mask !== false;
  const hasBank = Boolean(doc.accountNumber?.trim() && doc.ifsc?.trim());
  const hasUpi = Boolean(doc.upi?.trim());
  return {
    accountHolderName: doc.accountHolderName,
    accountNumber: mask ? maskAccountNumber(doc.accountNumber) : doc.accountNumber?.trim() || null,
    ifsc: doc.ifsc?.trim().toUpperCase() || null,
    upi: mask ? maskUpi(doc.upi) : doc.upi?.trim().toLowerCase() || null,
    phone: doc.phone?.trim() || null,
    isComplete: Boolean(doc.accountHolderName?.trim() && (hasBank || hasUpi)),
    updatedAt: (doc.updatedAt ?? new Date()).toISOString(),
  };
}

export function validatePayoutAccountInput(input: PayoutAccountInput): string | null {
  const name = input.accountHolderName?.trim() ?? '';
  if (name.length < 2) return 'Account holder name is required';
  const accountNumber = input.accountNumber?.replace(/\s/g, '') ?? '';
  const ifsc = input.ifsc?.trim().toUpperCase() ?? '';
  const upi = input.upi?.trim().toLowerCase() ?? '';
  const hasBank = accountNumber.length > 0 && ifsc.length > 0;
  const hasUpi = upi.length > 0;
  if (!hasBank && !hasUpi) {
    return 'Add UPI ID or bank account number with IFSC';
  }
  if (accountNumber && !ifsc) return 'IFSC is required when account number is provided';
  if (ifsc && !accountNumber) return 'Account number is required when IFSC is provided';
  if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) return 'Invalid IFSC format';
  if (upi && !/^[\w.\-]{2,}@[\w.\-]{2,}$/i.test(upi)) return 'Invalid UPI ID format';
  return null;
}

export async function getStaffWalletCommissionMeta(
  staff: Pick<IUser, '_id' | 'role' | 'bdId'>
): Promise<{ commissionPctOfHostEarnings: number; commissionNote: string }> {
  if (isBdRole(staff.role)) {
    const rates = await resolveStaffCommissionBps({
      bdUserId: staff._id,
      bdId: null,
    });
    const commissionPctOfHostEarnings = rates.bdBps / 100;
    return {
      commissionPctOfHostEarnings,
      commissionNote:
        'You earn this percentage of host earnings on each settled call. Credits go to this wallet and are not deducted from creators.',
    };
  }

  const agencyId = staff._id;
  const bdUserId = (staff.bdId ?? agencyId) as mongoose.Types.ObjectId;
  const rates = await resolveStaffCommissionBps({
    bdUserId,
    bdId: isAgencyRole(staff.role) ? agencyId : null,
  });
  const commissionPctOfHostEarnings = rates.agencyBps / 100;
  return {
    commissionPctOfHostEarnings,
    commissionNote:
      'You earn this percentage of host earnings on each settled call. Credits go to this wallet and are not deducted from creators.',
  };
}

export async function getStaffWalletSummary(staffUserId: mongoose.Types.ObjectId) {
  const user = await User.findById(staffUserId).select('staffCoinsBalance').lean();
  const balance = user?.staffCoinsBalance ?? 0;

  const [creditAgg, withdrawnAgg, pendingCount] = await Promise.all([
    StaffWalletLedger.aggregate<{ t: number }>([
      { $match: { staffUserId, direction: 'credit' } },
      { $group: { _id: null, t: { $sum: '$amountCoins' } } },
    ]),
    Withdrawal.aggregate<{ t: number }>([
      {
        $match: {
          staffUserId,
          status: { $in: ['approved', 'paid'] },
        },
      },
      { $group: { _id: null, t: { $sum: '$amount' } } },
    ]),
    Withdrawal.countDocuments({ staffUserId, status: 'pending' }),
  ]);

  const payoutDoc = await StaffPayoutAccount.findOne({ staffUserId }).lean();

  return {
    balance,
    totalEarningsCoins: creditAgg[0]?.t ?? 0,
    totalWithdrawnCoins: withdrawnAgg[0]?.t ?? 0,
    pendingWithdrawalCount: pendingCount,
    payoutAccount: payoutDoc ? serializePayoutAccount(payoutDoc) : null,
    payoutAccountBound: Boolean(payoutDoc && serializePayoutAccount(payoutDoc).isComplete),
  };
}

export async function listStaffWalletTransactions(
  staffUserId: mongoose.Types.ObjectId,
  page: number,
  limit: number,
) {
  const safeLimit = Math.min(100, Math.max(1, limit));
  const skip = (Math.max(1, page) - 1) * safeLimit;

  const [rows, total] = await Promise.all([
    StaffWalletLedger.find({ staffUserId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(safeLimit)
      .select(
        'direction amountCoins balanceAfter sourceType callId description withdrawalId createdAt',
      )
      .lean(),
    StaffWalletLedger.countDocuments({ staffUserId }),
  ]);

  return {
    transactions: rows.map((r) => ({
      id: r._id.toString(),
      direction: r.direction,
      amountCoins: r.amountCoins,
      balanceAfter: r.balanceAfter ?? null,
      sourceType: r.sourceType,
      callId: r.callId ?? null,
      description: r.description ?? labelForSourceType(r.sourceType),
      withdrawalId: r.withdrawalId?.toString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    pagination: {
      page: Math.max(1, page),
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    },
  };
}

function labelForSourceType(sourceType: string): string {
  switch (sourceType) {
    case 'call_settlement':
      return 'Call commission';
    case 'withdrawal_reserve':
      return 'Withdrawal approved';
    case 'withdrawal_paid':
      return 'Withdrawal paid';
    case 'withdrawal_reject_refund':
      return 'Withdrawal refund';
    case 'admin_adjustment':
      return 'Admin adjustment';
    case 'referral_transfer':
      return 'Referral transfer';
    default:
      return sourceType;
  }
}

export async function listStaffWalletWithdrawals(
  staffUserId: mongoose.Types.ObjectId,
  page: number,
  limit: number,
  status?: string,
) {
  const safeLimit = Math.min(100, Math.max(1, limit));
  const skip = (Math.max(1, page) - 1) * safeLimit;
  const filter: Record<string, unknown> = { staffUserId };
  if (status && ['pending', 'approved', 'rejected', 'paid'].includes(status)) {
    filter.status = status;
  }

  const [rows, total] = await Promise.all([
    Withdrawal.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(safeLimit)
      .select('amount status requestedAt processedAt notes name number upi accountNumber ifsc createdAt')
      .lean(),
    Withdrawal.countDocuments(filter),
  ]);

  return {
    withdrawals: rows.map((w) => ({
      id: w._id.toString(),
      amount: w.amount,
      status: w.status,
      requestedAt: (w.requestedAt ?? w.createdAt).toISOString(),
      processedAt: w.processedAt?.toISOString() ?? null,
      notes: w.notes ?? null,
      payout: {
        accountHolderName: w.name ?? null,
        phone: w.number ?? null,
        upi: w.upi ?? null,
        accountNumber: maskAccountNumber(w.accountNumber),
        ifsc: w.ifsc ?? null,
      },
    })),
    pagination: {
      page: Math.max(1, page),
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    },
  };
}

export async function upsertStaffPayoutAccount(
  staffUserId: mongoose.Types.ObjectId,
  input: PayoutAccountInput,
) {
  const err = validatePayoutAccountInput(input);
  if (err) throw new Error(err);

  const payload = {
    accountHolderName: input.accountHolderName.trim(),
    accountNumber: input.accountNumber?.replace(/\s/g, '') || undefined,
    ifsc: input.ifsc?.trim().toUpperCase() || undefined,
    upi: input.upi?.trim().toLowerCase() || undefined,
    phone: input.phone?.trim() || undefined,
  };

  const doc = await StaffPayoutAccount.findOneAndUpdate(
    { staffUserId },
    { $set: payload },
    { upsert: true, new: true },
  ).lean();

  return serializePayoutAccount(doc!, { mask: false });
}

export async function createStaffWithdrawalRequest(
  staffUserId: mongoose.Types.ObjectId,
  amountRaw: number,
  opts?: { blockIfbdDisabled?: boolean },
) {
  const amount = Math.floor(amountRaw);
  if (!Number.isFinite(amount) || amount < MIN_STAFF_WITHDRAWAL_COINS) {
    throw new Error(`Minimum withdrawal amount is ${MIN_STAFF_WITHDRAWAL_COINS} coins`);
  }

  const user = await User.findById(staffUserId).select('staffCoinsBalance bdDisabled role').lean();
  if (!user) throw new Error('Unauthorized');
  if (opts?.blockIfbdDisabled && user.bdDisabled) {
    throw new Error('Account is disabled — new payout requests are blocked');
  }

  const balance = user.staffCoinsBalance ?? 0;
  if (amount > balance) {
    throw new Error('Insufficient wallet balance');
  }

  const oneDayAgo = new Date(Date.now() - STAFF_WITHDRAWAL_COOLDOWN_MS);
  const recent = await Withdrawal.findOne({
    staffUserId,
    $or: [{ status: 'pending' }, { requestedAt: { $gte: oneDayAgo } }],
  })
    .select('status requestedAt')
    .lean();

  if (recent?.status === 'pending') {
    throw new Error('You already have a pending withdrawal request');
  }
  if (recent && recent.requestedAt && recent.requestedAt >= oneDayAgo) {
    throw new Error('You can only request one withdrawal per 24 hours');
  }

  const payoutDoc = await StaffPayoutAccount.findOne({ staffUserId }).lean();
  if (!payoutDoc || !serializePayoutAccount(payoutDoc).isComplete) {
    throw new Error('Bind a payout account in Wallet before requesting withdrawal');
  }

  const w = await Withdrawal.create({
    staffUserId,
    amount,
    status: 'pending',
    requestedAt: new Date(),
    name: payoutDoc.accountHolderName,
    number: payoutDoc.phone,
    upi: payoutDoc.upi,
    accountNumber: payoutDoc.accountNumber,
    ifsc: payoutDoc.ifsc,
  });

  emitToAdmin('withdrawal:requested', {
    withdrawalId: w._id.toString(),
    staffUserId: staffUserId.toString(),
    amount: w.amount,
    kind: 'staff',
  });
  invalidateAdminCaches('overview').catch(() => {});

  return {
    id: w._id.toString(),
    amount: w.amount,
    status: w.status,
    requestedAt: w.requestedAt.toISOString(),
  };
}
