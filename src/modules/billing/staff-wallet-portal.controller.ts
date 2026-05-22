import type { Request, Response } from 'express';
import { assertAgency, assertBd, loadStaffUserByAuth } from '../../middlewares/staff.middleware';
import { logError } from '../../utils/logger';
import {
  createStaffWithdrawalRequest,
  getStaffWalletCommissionMeta,
  getStaffWalletSummary,
  listStaffWalletTransactions,
  listStaffWalletWithdrawals,
  upsertStaffPayoutAccount,
} from './staff-wallet-portal.service';

async function resolveStaff(
  req: Request,
  res: Response,
  portal: 'bd' | 'agency',
) {
  const ok = portal === 'bd' ? await assertBd(req, res) : await assertAgency(req, res);
  if (!ok) return null;
  const staff = await loadStaffUserByAuth(req);
  if (!staff) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return null;
  }
  return staff;
}

function parsePageLimit(req: Request) {
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '25'), 10) || 25));
  return { page, limit };
}

export const getBdWallet = async (req: Request, res: Response): Promise<void> => {
  try {
    const staff = await resolveStaff(req, res, 'bd');
    if (!staff) return;
    const [data, commission] = await Promise.all([
      getStaffWalletSummary(staff._id),
      getStaffWalletCommissionMeta(staff),
    ]);
    res.json({ success: true, data: { ...data, ...commission } });
  } catch (error) {
    logError('getBdWallet', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getAgencyWallet = async (req: Request, res: Response): Promise<void> => {
  try {
    const staff = await resolveStaff(req, res, 'agency');
    if (!staff) return;
    const [data, commission] = await Promise.all([
      getStaffWalletSummary(staff._id),
      getStaffWalletCommissionMeta(staff),
    ]);
    res.json({ success: true, data: { ...data, ...commission } });
  } catch (error) {
    logError('getAgentWallet', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getBdWalletTransactions = async (req: Request, res: Response): Promise<void> => {
  try {
    const staff = await resolveStaff(req, res, 'bd');
    if (!staff) return;
    const { page, limit } = parsePageLimit(req);
    const data = await listStaffWalletTransactions(staff._id, page, limit);
    res.json({ success: true, data });
  } catch (error) {
    logError('getBdWalletTransactions', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getAgencyWalletTransactions = async (req: Request, res: Response): Promise<void> => {
  try {
    const staff = await resolveStaff(req, res, 'agency');
    if (!staff) return;
    const { page, limit } = parsePageLimit(req);
    const data = await listStaffWalletTransactions(staff._id, page, limit);
    res.json({ success: true, data });
  } catch (error) {
    logError('getAgentWalletTransactions', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getBdWalletWithdrawals = async (req: Request, res: Response): Promise<void> => {
  try {
    const staff = await resolveStaff(req, res, 'bd');
    if (!staff) return;
    const { page, limit } = parsePageLimit(req);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const data = await listStaffWalletWithdrawals(staff._id, page, limit, status);
    res.json({ success: true, data });
  } catch (error) {
    logError('getBdWalletWithdrawals', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getAgencyWalletWithdrawals = async (req: Request, res: Response): Promise<void> => {
  try {
    const staff = await resolveStaff(req, res, 'agency');
    if (!staff) return;
    const { page, limit } = parsePageLimit(req);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const data = await listStaffWalletWithdrawals(staff._id, page, limit, status);
    res.json({ success: true, data });
  } catch (error) {
    logError('getAgentWalletWithdrawals', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const putBdWalletPayoutAccount = async (req: Request, res: Response): Promise<void> => {
  try {
    const staff = await resolveStaff(req, res, 'bd');
    if (!staff) return;
    const payoutAccount = await upsertStaffPayoutAccount(staff._id, {
      accountHolderName: String(req.body?.accountHolderName ?? req.body?.name ?? ''),
      accountNumber: typeof req.body?.accountNumber === 'string' ? req.body.accountNumber : undefined,
      ifsc: typeof req.body?.ifsc === 'string' ? req.body.ifsc : undefined,
      upi: typeof req.body?.upi === 'string' ? req.body.upi : undefined,
      phone: typeof req.body?.phone === 'string' ? req.body.phone : req.body?.number,
    });
    res.json({ success: true, data: { payoutAccount } });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Invalid payout account';
    res.status(400).json({ success: false, error: msg });
  }
};

export const putAgencyWalletPayoutAccount = async (req: Request, res: Response): Promise<void> => {
  try {
    const staff = await resolveStaff(req, res, 'agency');
    if (!staff) return;
    const payoutAccount = await upsertStaffPayoutAccount(staff._id, {
      accountHolderName: String(req.body?.accountHolderName ?? req.body?.name ?? ''),
      accountNumber: typeof req.body?.accountNumber === 'string' ? req.body.accountNumber : undefined,
      ifsc: typeof req.body?.ifsc === 'string' ? req.body.ifsc : undefined,
      upi: typeof req.body?.upi === 'string' ? req.body.upi : undefined,
      phone: typeof req.body?.phone === 'string' ? req.body.phone : req.body?.number,
    });
    res.json({ success: true, data: { payoutAccount } });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Invalid payout account';
    res.status(400).json({ success: false, error: msg });
  }
};

export const postBdWalletWithdrawal = async (req: Request, res: Response): Promise<void> => {
  try {
    const staff = await resolveStaff(req, res, 'bd');
    if (!staff) return;
    const amount = Number(req.body?.amount);
    const data = await createStaffWithdrawalRequest(staff._id, amount, {
      blockIfbdDisabled: true,
    });
    res.status(201).json({ success: true, data });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Could not create withdrawal';
    res.status(400).json({ success: false, error: msg });
  }
};

export const postAgencyWalletWithdrawal = async (req: Request, res: Response): Promise<void> => {
  try {
    const staff = await resolveStaff(req, res, 'agency');
    if (!staff) return;
    const amount = Number(req.body?.amount);
    const data = await createStaffWithdrawalRequest(staff._id, amount);
    res.status(201).json({ success: true, data });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Could not create withdrawal';
    res.status(400).json({ success: false, error: msg });
  }
};
