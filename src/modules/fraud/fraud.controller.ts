import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { assertAdmin } from '../../middlewares/staff.middleware';
import { User } from '../user/user.model';
import { FraudSignal } from './fraud-signal.model';
import { FraudInvestigation } from './fraud-investigation.model';
import { runStubFraudRulesScan } from './fraud-rules/run-stub-rules';

export const getFraudSignals = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));
    const skip = (page - 1) * limit;
    const status = String(req.query.status ?? '').trim();
    const q: Record<string, unknown> = {};
    if (status) q.status = status;

    const [signals, total] = await Promise.all([
      FraudSignal.find(q).sort({ triggeredAt: -1 }).skip(skip).limit(limit).lean(),
      FraudSignal.countDocuments(q),
    ]);

    res.json({
      success: true,
      data: {
        signals: signals.map((s) => ({
          id: s._id.toString(),
          ruleId: s.ruleId,
          severity: s.severity,
          reason: s.reason,
          metadata: s.metadata,
          subjectUserId: s.subjectUserId?.toString() ?? null,
          status: s.status,
          triggeredAt: s.triggeredAt,
          resolvedAt: s.resolvedAt,
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    console.error('getFraudSignals error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getFraudInvestigations = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '30'), 10) || 30));
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      FraudInvestigation.find({}).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
      FraudInvestigation.countDocuments({}),
    ]);

    res.json({
      success: true,
      data: {
        investigations: rows.map((r) => ({
          id: r._id.toString(),
          title: r.title,
          status: r.status,
          signalIds: r.signalIds.map((x) => x.toString()),
          notes: r.notes,
          subjectUserId: r.subjectUserId?.toString() ?? null,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    console.error('getFraudInvestigations error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const postFraudInvestigationNote = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const { id } = req.params;
    const text = String(req.body?.text ?? '').trim();
    if (!mongoose.Types.ObjectId.isValid(id) || text.length < 1) {
      res.status(400).json({ success: false, error: 'Invalid id or text' });
      return;
    }

    const admin = await User.findOne({
      firebaseUid: (req as { auth?: { firebaseUid?: string } }).auth?.firebaseUid,
    })
      .select('_id')
      .lean();
    const inv = await FraudInvestigation.findById(id);
    if (!inv) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    inv.notes.push({
      at: new Date(),
      text: text.slice(0, 8000),
      authorUserId: admin?._id as mongoose.Types.ObjectId | undefined,
    });
    await inv.save();

    res.json({ success: true, data: { id: inv._id.toString(), notesCount: inv.notes.length } });
  } catch (error) {
    console.error('postFraudInvestigationNote error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const postFraudRulesRun = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const out = await runStubFraudRulesScan();
    res.json({ success: true, data: out });
  } catch (error) {
    console.error('postFraudRulesRun error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
