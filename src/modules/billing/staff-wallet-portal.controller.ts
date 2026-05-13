import type { Request, Response } from 'express';
import { assertAgency, assertAgent, loadStaffUserByAuth } from '../../middlewares/staff.middleware';
import { logError } from '../../utils/logger';
import {
  createStaffWithdrawalRequest,
  getStaffWalletSummary,
  listStaffWalletTransactions,
  listStaffWalletWithdrawals,
  upsertStaffPayoutAccount,
} from './staff-wallet-portal.service';

async function resolveStaff(
  req: Request,
  res: Response,
  portal: 'agency' | 'agent',
) {
  const ok = portal === 'agency' ? await assertAgency(req, res) : await assertAgent(req, res);
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

export const getAgencyWallet = async (req: Request, res: Response): Promise<void> => {
  try {
    const staff = await resolveStaff(req, res, 'agency');
    if (!staff) return;
    const data = await getStaffWalletSummary(staff._id);
    res.json({ success: true, data });
  } catch (error) {
    logError('getAgencyWallet', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getAgentWallet = async (req: Request, res: Response): Promise<void> => {
  try {
    const staff = await resolveStaff(req, res, 'agent');
    if (!staff) return;
    const data = await getStaffWalletSummary(staff._id);
    res.json({ success: true, data });
  } catch (error) {
    logError('getAgentWallet', error as Error);
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
    logError('getAgencyWalletTransactions', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getAgentWalletTransactions = async (req: Request, res: Response): Promise<void> => {
  try {
    const staff = await resolveStaff(req, res, 'agent');
    if (!staff) return;
    const { page, limit } = parsePageLimit(req);
    const data = await listStaffWalletTransactions(staff._id, page, limit);
    res.json({ success: true, data });
  } catch (error) {
    logError('getAgentWalletTransactions', error as Error);
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
    logError('getAgencyWalletWithdrawals', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getAgentWalletWithdrawals = async (req: Request, res: Response): Promise<void> => {
  try {
    const staff = await resolveStaff(req, res, 'agent');
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

export const putAgentWalletPayoutAccount = async (req: Request, res: Response): Promise<void> => {
  try {
    const staff = await resolveStaff(req, res, 'agent');
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

export const postAgencyWalletWithdrawal = async (req: Request, res: Response): Promise<void> => {
  try {
    const staff = await resolveStaff(req, res, 'agency');
    if (!staff) return;
    const amount = Number(req.body?.amount);
    const data = await createStaffWithdrawalRequest(staff._id, amount, {
      blockIfAgencyDisabled: true,
    });
    res.status(201).json({ success: true, data });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Could not create withdrawal';
    res.status(400).json({ success: false, error: msg });
  }
};

export const postAgentWalletWithdrawal = async (req: Request, res: Response): Promise<void> => {
  try {
    const staff = await resolveStaff(req, res, 'agent');
    if (!staff) return;
    const amount = Number(req.body?.amount);
    const data = await createStaffWithdrawalRequest(staff._id, amount);
    res.status(201).json({ success: true, data });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Could not create withdrawal';
    res.status(400).json({ success: false, error: msg });
  }
};
