import { randomUUID } from 'crypto';
import type { Types } from 'mongoose';
import { User } from '../user/user.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { Withdrawal, type IWithdrawal } from './withdrawal.model';
import { Creator } from './creator.model';
import {
  invalidateAdminCaches,
} from '../../config/redis';
import { verifyUserBalance } from '../../utils/balance-integrity';
import { getIO } from '../../config/socket';
import { emitToAdmin } from '../admin/admin.gateway';
import { emitCreatorDataUpdated } from './creator-notify';
import { AdminActionLog } from '../admin/admin-action-log.model';

type ActingUserLean = {
  _id: Types.ObjectId;
  email?: string | null;
  role: string;
};

async function logStaffWithdrawalAction(
  actingUser: ActingUserLean | null | undefined,
  action: string,
  targetId: string,
  reason: string,
  details: Record<string, unknown>
): Promise<void> {
  try {
    if (!actingUser?._id) return;
    await new AdminActionLog({
      adminUserId: actingUser._id,
      adminEmail: actingUser.email || actingUser.role || 'staff',
      action,
      targetType: 'withdrawal',
      targetId,
      reason,
      details,
    }).save();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('⚠️ [WITHDRAWAL] Failed to write action log:', err);
  }
}

export async function resolveWithdrawalCreatorUser(
  withdrawal: IWithdrawal
): Promise<InstanceType<typeof User> | null> {
  if (withdrawal.creatorUserId) {
    return User.findById(withdrawal.creatorUserId);
  }
  const uid = (withdrawal as { creatorFirebaseUid?: string }).creatorFirebaseUid;
  if (uid) {
    return User.findOne({ firebaseUid: uid });
  }
  return null;
}

export async function withdrawalManagedByAgent(
  withdrawal: IWithdrawal,
  agentUserId: Types.ObjectId
): Promise<boolean> {
  if (withdrawal.assignedAgentId && withdrawal.assignedAgentId.equals(agentUserId)) {
    return true;
  }
  if (!withdrawal.creatorUserId) return false;
  const c = await Creator.findOne({ userId: withdrawal.creatorUserId })
    .select('assignedAgentId')
    .lean();
  return !!(c?.assignedAgentId && c.assignedAgentId.equals(agentUserId));
}

export type WithdrawalActionResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number; error: string };

export async function processWithdrawalApproval(
  withdrawalId: string,
  actingUser: ActingUserLean,
  options: { notes?: string; isAdmin: boolean }
): Promise<WithdrawalActionResult> {
  const withdrawal = await Withdrawal.findById(withdrawalId);
  if (!withdrawal) {
    return { ok: false, status: 404, error: 'Withdrawal not found' };
  }

  if (!options.isAdmin) {
    const allowed = await withdrawalManagedByAgent(withdrawal, actingUser._id);
    if (!allowed) {
      return { ok: false, status: 403, error: 'This withdrawal is not assigned to you' };
    }
  }

  if (withdrawal.status !== 'pending') {
    return {
      ok: false,
      status: 400,
      error: `Cannot approve withdrawal with status '${withdrawal.status}'. Only pending withdrawals can be approved.`,
    };
  }

  const creatorUser = await resolveWithdrawalCreatorUser(withdrawal);
  if (!creatorUser) {
    return { ok: false, status: 404, error: 'Creator user not found' };
  }

  const creatorDoc = await Creator.findOne({ userId: creatorUser._id });
  const availableBalance = creatorUser.coins;
  if (availableBalance < withdrawal.amount) {
    return {
      ok: false,
      status: 400,
      error: `Creator balance (${availableBalance}) is less than withdrawal amount (${withdrawal.amount}). Cannot approve.`,
    };
  }

  const txId = `withdrawal_${withdrawal._id}_${randomUUID()}`;
  const oldCoins = creatorUser.coins;
  const oldEarnings = creatorDoc?.earningsCoins ?? 0;

  await new CoinTransaction({
    transactionId: txId,
    userId: creatorUser._id,
    type: 'debit',
    coins: withdrawal.amount,
    source: 'withdrawal',
    description: `Withdrawal approved by ${actingUser.email || actingUser.role}${options.notes ? ': ' + options.notes.trim() : ''}`,
    status: 'completed',
  }).save();

  creatorUser.coins -= withdrawal.amount;
  await creatorUser.save();

  if (creatorDoc) {
    creatorDoc.earningsCoins = Math.max(0, creatorDoc.earningsCoins - withdrawal.amount);
    await creatorDoc.save();
  }

  withdrawal.status = 'approved';
  withdrawal.processedAt = new Date();
  withdrawal.adminUserId = actingUser._id;
  withdrawal.notes = options.notes?.trim() || undefined;
  withdrawal.transactionId = txId;
  if (!withdrawal.creatorUserId) {
    withdrawal.creatorUserId = creatorUser._id;
  }
  await withdrawal.save();

  await logStaffWithdrawalAction(actingUser, 'WITHDRAWAL_APPROVED', withdrawal._id.toString(), options.notes?.trim() || 'Withdrawal approved', {
    transactionId: txId,
    creatorUserId: creatorUser._id.toString(),
    amount: withdrawal.amount,
    oldBalance: oldCoins,
    newBalance: creatorUser.coins,
    oldEarnings,
    newEarnings: creatorDoc?.earningsCoins ?? 0,
    actorRole: actingUser.role,
  });

  verifyUserBalance(creatorUser._id).catch(() => {});

  try {
    const io = getIO();
    io.to(`user:${creatorUser.firebaseUid}`).emit('coins_updated', {
      userId: creatorUser._id.toString(),
      coins: creatorUser.coins,
    });
  } catch {
    /* optional socket */
  }

  try {
    emitCreatorDataUpdated(creatorUser.firebaseUid, {
      reason: 'withdrawal_approved',
      coins: creatorUser.coins,
      withdrawalAmount: withdrawal.amount,
      withdrawalId: withdrawal._id.toString(),
    });
  } catch {
    /* optional */
  }

  await invalidateAdminCaches('overview', 'coins', 'creators_performance');
  emitToAdmin('withdrawal:updated', {
    withdrawalId: withdrawal._id.toString(),
    status: 'approved',
  });

  return {
    ok: true,
    data: {
      withdrawalId: withdrawal._id.toString(),
      status: 'approved',
      amount: withdrawal.amount,
      transactionId: txId,
      creatorOldBalance: oldCoins,
      creatorNewBalance: creatorUser.coins,
    },
  };
}

export async function processWithdrawalRejection(
  withdrawalId: string,
  actingUser: ActingUserLean,
  options: { notes: string; isAdmin: boolean }
): Promise<WithdrawalActionResult> {
  const notes = options.notes.trim();
  if (notes.length < 3) {
    return { ok: false, status: 400, error: 'Notes/reason is required (min 3 characters)' };
  }

  const withdrawal = await Withdrawal.findById(withdrawalId);
  if (!withdrawal) {
    return { ok: false, status: 404, error: 'Withdrawal not found' };
  }

  if (!options.isAdmin) {
    const allowed = await withdrawalManagedByAgent(withdrawal, actingUser._id);
    if (!allowed) {
      return { ok: false, status: 403, error: 'This withdrawal is not assigned to you' };
    }
  }

  if (withdrawal.status !== 'pending') {
    return {
      ok: false,
      status: 400,
      error: `Cannot reject withdrawal with status '${withdrawal.status}'. Only pending withdrawals can be rejected.`,
    };
  }

  withdrawal.status = 'rejected';
  withdrawal.adminUserId = actingUser._id;
  withdrawal.notes = notes;
  withdrawal.processedAt = new Date();
  await withdrawal.save();

  await logStaffWithdrawalAction(actingUser, 'WITHDRAWAL_REJECTED', withdrawal._id.toString(), notes, {
    creatorUserId: withdrawal.creatorUserId?.toString() || (withdrawal as { creatorFirebaseUid?: string }).creatorFirebaseUid || 'unknown',
    amount: withdrawal.amount,
    actorRole: actingUser.role,
  });

  await invalidateAdminCaches('overview', 'coins', 'creators_performance');
  emitToAdmin('withdrawal:updated', {
    withdrawalId: withdrawal._id.toString(),
    status: 'rejected',
  });

  return {
    ok: true,
    data: {
      withdrawalId: withdrawal._id.toString(),
      status: 'rejected',
      amount: withdrawal.amount,
      notes,
    },
  };
}

export async function processWithdrawalMarkPaid(
  withdrawalId: string,
  actingUser: ActingUserLean,
  options: { notes?: string; isAdmin: boolean }
): Promise<WithdrawalActionResult> {
  const withdrawal = await Withdrawal.findById(withdrawalId);
  if (!withdrawal) {
    return { ok: false, status: 404, error: 'Withdrawal not found' };
  }

  if (!options.isAdmin) {
    const allowed = await withdrawalManagedByAgent(withdrawal, actingUser._id);
    if (!allowed) {
      return { ok: false, status: 403, error: 'This withdrawal is not assigned to you' };
    }
  }

  if (withdrawal.status !== 'approved') {
    return {
      ok: false,
      status: 400,
      error: `Cannot mark as paid. Withdrawal status is '${withdrawal.status}', expected 'approved'.`,
    };
  }

  withdrawal.status = 'paid';
  withdrawal.processedAt = new Date();
  if (options.notes?.trim()) {
    withdrawal.notes =
      (withdrawal.notes || '') + (withdrawal.notes ? ' | ' : '') + `Paid: ${options.notes.trim()}`;
  }
  await withdrawal.save();

  let creatorUser: InstanceType<typeof User> | null = null;
  if (withdrawal.creatorUserId) {
    creatorUser = await User.findById(withdrawal.creatorUserId);
  } else {
    const uid = (withdrawal as { creatorFirebaseUid?: string }).creatorFirebaseUid;
    if (uid) creatorUser = await User.findOne({ firebaseUid: uid });
  }
  if (creatorUser) {
    const creatorDoc = await Creator.findOne({ userId: creatorUser._id });
    if (creatorDoc && creatorDoc.earningsCoins > 0) {
      creatorDoc.earningsCoins = Math.max(0, creatorDoc.earningsCoins - withdrawal.amount);
      await creatorDoc.save();
    }
  }

  await logStaffWithdrawalAction(actingUser, 'WITHDRAWAL_PAID', withdrawal._id.toString(), options.notes?.trim() || 'Marked as paid', {
    creatorUserId: withdrawal.creatorUserId?.toString() || (withdrawal as { creatorFirebaseUid?: string }).creatorFirebaseUid || 'unknown',
    amount: withdrawal.amount,
    processedAt: withdrawal.processedAt.toISOString(),
    actorRole: actingUser.role,
  });

  await invalidateAdminCaches('overview', 'coins', 'creators_performance');
  emitToAdmin('withdrawal:updated', {
    withdrawalId: withdrawal._id.toString(),
    status: 'paid',
  });

  return {
    ok: true,
    data: {
      withdrawalId: withdrawal._id.toString(),
      status: 'paid',
      amount: withdrawal.amount,
      processedAt: withdrawal.processedAt.toISOString(),
    },
  };
}
