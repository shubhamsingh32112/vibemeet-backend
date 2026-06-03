import type { Request, Response } from 'express';
import { assertAdmin } from '../../middlewares/staff.middleware';
import { logError } from '../../utils/logger';
import {
  auditMomentPurchase,
  regrantMomentEntitlement,
  refundMomentPurchase,
} from '../moments/services/moment-purchase-admin.service';

export async function listMomentPurchasesHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const { userId, momentId, transactionId } = req.query as {
      userId?: string;
      momentId?: string;
      transactionId?: string;
    };
    const audit = await auditMomentPurchase({ userId, momentId, transactionId });
    res.json({ success: true, data: audit });
  } catch (error) {
    logError('List moment purchases failed', error);
    res.status(500).json({ success: false, error: 'Failed to audit moment purchase' });
  }
}

export async function regrantMomentPurchaseHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const { userId, momentId, reason, ticketId, forceRepair } = req.body as {
      userId?: string;
      momentId?: string;
      reason?: string;
      ticketId?: string;
      forceRepair?: boolean;
    };
    if (!userId || !momentId || !reason || !ticketId) {
      res.status(400).json({
        success: false,
        error: 'userId, momentId, reason, and ticketId are required',
      });
      return;
    }
    const result = await regrantMomentEntitlement({
      userId,
      momentId,
      reason,
      ticketId,
      actor: req.auth?.firebaseUid ?? 'admin',
      forceRepair: Boolean(forceRepair),
    });
    res.json({ success: true, data: result });
  } catch (error) {
    logError('Regrant moment purchase failed', error);
    res.status(400).json({ success: false, error: (error as Error).message });
  }
}

export async function refundMomentPurchaseHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const { purchaseId, userId, momentId, reason, ticketId } = req.body as {
      purchaseId?: string;
      userId?: string;
      momentId?: string;
      reason?: string;
      ticketId?: string;
    };
    if (!reason || !ticketId || (!purchaseId && !(userId && momentId))) {
      res.status(400).json({
        success: false,
        error: 'reason, ticketId, and purchaseId or (userId+momentId) are required',
      });
      return;
    }
    const result = await refundMomentPurchase({
      purchaseId,
      userId,
      momentId,
      reason,
      ticketId,
      actor: req.auth?.firebaseUid ?? 'admin',
    });
    res.json({ success: true, data: result });
  } catch (error) {
    logError('Refund moment purchase failed', error);
    res.status(400).json({ success: false, error: (error as Error).message });
  }
}
