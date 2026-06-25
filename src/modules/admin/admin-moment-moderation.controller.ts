import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { assertAdmin } from '../../middlewares/staff.middleware';
import { logError, logInfo } from '../../utils/logger';
import { CreatorMoment } from '../moments/models/creator-moment.model';
import { CreatorStory } from '../stories/models/creator-story.model';
import { ESCALATED_MODERATION_STATUSES, type ContentModerationStatus } from '../media-shared/types';

async function setModerationStatus(
  kind: 'moment' | 'story',
  id: string,
  status: ContentModerationStatus,
): Promise<boolean> {
  if (kind === 'moment') {
    const updated = await CreatorMoment.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $set: { moderationStatus: status } },
      { new: true },
    );
    return Boolean(updated);
  }
  const updated = await CreatorStory.findOneAndUpdate(
    { _id: id, isDeleted: false },
    { $set: { moderationStatus: status } },
    { new: true },
  );
  return Boolean(updated);
}

export async function listPendingMomentsModerationHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const [moments, stories] = await Promise.all([
      CreatorMoment.find({ moderationStatus: 'pending', isDeleted: false })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select('_id creatorId type caption createdAt moderationStatus processingStatus')
        .lean(),
      CreatorStory.find({ moderationStatus: 'pending', isDeleted: false })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select('_id creatorId type caption createdAt moderationStatus processingStatus expiresAt')
        .lean(),
    ]);
    res.json({
      success: true,
      data: {
        moments,
        stories,
      },
    });
  } catch (error) {
    logError('List pending moments moderation failed', error);
    res.status(500).json({ success: false, error: 'Failed to list pending content' });
  }
}

export async function approveMomentModerationHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const { kind, id } = req.body as { kind?: 'moment' | 'story'; id?: string };
    if ((kind !== 'moment' && kind !== 'story') || !id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, error: 'kind (moment|story) and valid id required' });
      return;
    }
    const ok = await setModerationStatus(kind, id, 'approved');
    if (!ok) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    logInfo('Moment/story moderation approved', { kind, id, admin: req.auth?.firebaseUid });
    res.json({ success: true, data: { kind, id, moderationStatus: 'approved' } });
  } catch (error) {
    logError('Approve moment moderation failed', error);
    res.status(500).json({ success: false, error: 'Failed to approve content' });
  }
}

export async function listEscalatedMomentsModerationHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const [moments, stories] = await Promise.all([
      CreatorMoment.find({
        moderationStatus: { $in: [...ESCALATED_MODERATION_STATUSES] },
        isDeleted: false,
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select(
          '_id creatorId type caption createdAt moderationStatus moderationReason processingStatus',
        )
        .lean(),
      CreatorStory.find({
        moderationStatus: { $in: [...ESCALATED_MODERATION_STATUSES] },
        isDeleted: false,
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select(
          '_id creatorId type caption createdAt moderationStatus moderationReason processingStatus expiresAt',
        )
        .lean(),
    ]);
    res.json({ success: true, data: { moments, stories } });
  } catch (error) {
    logError('List escalated moments moderation failed', error);
    res.status(500).json({ success: false, error: 'Failed to list escalated content' });
  }
}

export async function escalateMomentModerationHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const { kind, id, status, reason } = req.body as {
      kind?: 'moment' | 'story';
      id?: string;
      status?: ContentModerationStatus;
      reason?: string;
    };
    if ((kind !== 'moment' && kind !== 'story') || !id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, error: 'kind (moment|story) and valid id required' });
      return;
    }
    if (!status || !ESCALATED_MODERATION_STATUSES.includes(status)) {
      res.status(400).json({
        success: false,
        error: `status must be one of: ${ESCALATED_MODERATION_STATUSES.join(', ')}`,
      });
      return;
    }
    if (!reason || reason.trim().length < 3) {
      res.status(400).json({ success: false, error: 'reason is required (min 3 chars)' });
      return;
    }
    const ok = await setModerationStatus(kind, id, status);
    if (!ok) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    const moderationMeta = {
      $set: { moderationReason: reason.trim(), moderatedAt: new Date() },
    };
    if (kind === 'moment') {
      await CreatorMoment.updateOne({ _id: id }, moderationMeta);
    } else {
      await CreatorStory.updateOne({ _id: id }, moderationMeta);
    }
    logInfo('Moment/story moderation escalated', {
      kind,
      id,
      status,
      admin: req.auth?.firebaseUid,
    });
    res.json({ success: true, data: { kind, id, moderationStatus: status } });
  } catch (error) {
    logError('Escalate moment moderation failed', error);
    res.status(500).json({ success: false, error: 'Failed to escalate content' });
  }
}

export async function rejectMomentModerationHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!(await assertAdmin(req, res))) return;
    const { kind, id, reason } = req.body as {
      kind?: 'moment' | 'story';
      id?: string;
      reason?: string;
    };
    if ((kind !== 'moment' && kind !== 'story') || !id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, error: 'kind (moment|story) and valid id required' });
      return;
    }
    if (!reason || reason.trim().length < 3) {
      res.status(400).json({ success: false, error: 'reason is required' });
      return;
    }
    const ok = await setModerationStatus(kind, id, 'rejected');
    if (!ok) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    logInfo('Moment/story moderation rejected', {
      kind,
      id,
      reason: reason.trim(),
      admin: req.auth?.firebaseUid,
    });
    res.json({ success: true, data: { kind, id, moderationStatus: 'rejected' } });
  } catch (error) {
    logError('Reject moment moderation failed', error);
    res.status(500).json({ success: false, error: 'Failed to reject content' });
  }
}
