import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { assertAdmin } from '../../middlewares/staff.middleware';
import { StaffWalletReconciliationLog } from './staff-wallet-reconciliation-log.model';
import { reconcileAllStaffBalances, reconcileStaffBalance } from './staff-wallet-reconciliation.service';

export const getStaffWalletReconciliationLogs = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = {};
    const sid = String(req.query.staffUserId ?? '').trim();
    if (sid && mongoose.Types.ObjectId.isValid(sid)) {
      query.staffUserId = new mongoose.Types.ObjectId(sid);
    }
    const runId = String(req.query.runId ?? '').trim();
    if (runId) query.runId = runId;
    const from = String(req.query.from ?? '').trim();
    const to = String(req.query.to ?? '').trim();
    if (from || to) {
      query.completedAt = {};
      if (from) (query.completedAt as Record<string, Date>).$gte = new Date(from);
      if (to) (query.completedAt as Record<string, Date>).$lte = new Date(to);
    }
    const driftOnly = req.query.driftOnly === 'true' || req.query.driftOnly === '1';
    if (driftOnly) {
      query.driftAmount = { $ne: 0 };
    }

    const [logs, total] = await Promise.all([
      StaffWalletReconciliationLog.find(query)
        .sort({ completedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      StaffWalletReconciliationLog.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: {
        logs: logs.map((l) => ({
          id: l._id.toString(),
          runId: l.runId,
          staffUserId: l.staffUserId.toString(),
          expectedBalance: l.expectedBalance,
          actualBalance: l.actualBalance,
          driftAmount: l.driftAmount,
          autoCorrected: l.autoCorrected,
          correctionAmount: l.correctionAmount,
          startedAt: l.startedAt,
          completedAt: l.completedAt,
          metadata: l.metadata,
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('getStaffWalletReconciliationLogs error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const postStaffWalletReconciliationRun = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const dryRun = req.body?.dryRun === true;
    const staffRaw = String(req.body?.staffUserId ?? '').trim();

    if (staffRaw && mongoose.Types.ObjectId.isValid(staffRaw)) {
      const runId = randomUUID();
      const startedAt = new Date();
      const result = await reconcileStaffBalance(new mongoose.Types.ObjectId(staffRaw), {
        runId,
        dryRun,
        startedAt,
      });
      res.json({ success: true, data: { scope: 'single', runId, result } });
      return;
    }

    const summary = await reconcileAllStaffBalances({ dryRun });
    res.json({ success: true, data: { scope: 'all', summary } });
  } catch (error) {
    console.error('postStaffWalletReconciliationRun error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
