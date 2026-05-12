import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { assertAdmin } from '../../middlewares/staff.middleware';
import { AuditEvent } from './audit-event.model';

export const getAuditEvents = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = {};
    const actor = String(req.query.actorUserId ?? '').trim();
    if (actor && mongoose.Types.ObjectId.isValid(actor)) {
      query.actorUserId = new mongoose.Types.ObjectId(actor);
    }
    const eventType = String(req.query.eventType ?? '').trim();
    if (eventType) query.eventType = eventType;
    const targetType = String(req.query.targetType ?? '').trim();
    if (targetType) query.targetType = targetType;
    const targetId = String(req.query.targetId ?? '').trim();
    if (targetId) query.targetId = targetId;
    const corr = String(req.query.correlationId ?? '').trim();
    if (corr) query.correlationId = corr;
    const from = String(req.query.from ?? '').trim();
    const to = String(req.query.to ?? '').trim();
    if (from || to) {
      query.createdAt = {};
      if (from) (query.createdAt as Record<string, Date>).$gte = new Date(from);
      if (to) (query.createdAt as Record<string, Date>).$lte = new Date(to);
    }

    const [events, total] = await Promise.all([
      AuditEvent.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AuditEvent.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: {
        events: events.map((e) => ({
          id: e._id.toString(),
          actorUserId: e.actorUserId?.toString() ?? null,
          actorRole: e.actorRole ?? null,
          eventType: e.eventType,
          targetType: e.targetType,
          targetId: e.targetId,
          metadata: e.metadata ?? {},
          ipAddress: e.ipAddress ?? null,
          userAgent: e.userAgent ?? null,
          correlationId: e.correlationId ?? null,
          requestId: e.requestId ?? null,
          createdAt: e.createdAt,
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
    console.error('getAuditEvents error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
