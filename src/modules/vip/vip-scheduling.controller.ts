import type { Request } from 'express';
import { Response } from 'express';
import { featureFlags } from '../../config/feature-flags';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { logError } from '../../utils/logger';
import {
  cancelScheduledCall,
  confirmScheduledCall,
  listCallerScheduledCalls,
  listCreatorIncomingScheduledCalls,
  scheduleVipCall,
  VipSchedulingError,
} from './vip-scheduling.service';

function rejectIfVipDisabled(res: Response): boolean {
  if (!featureFlags.vipEnabled) {
    res.status(503).json({ success: false, error: 'VIP is not available yet' });
    return true;
  }
  return false;
}

export const scheduleCall = async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectIfVipDisabled(res)) return;

    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { creatorId, scheduledAt, durationMinutes, notes } = req.body as {
      creatorId?: string;
      scheduledAt?: string;
      durationMinutes?: number;
      notes?: string;
    };

    if (!creatorId || !scheduledAt) {
      res.status(400).json({ success: false, error: 'creatorId and scheduledAt are required' });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const call = await scheduleVipCall({
      callerUserId: user._id,
      creatorId,
      scheduledAt: new Date(scheduledAt),
      durationMinutes,
      notes,
    });

    res.status(201).json({
      success: true,
      data: {
        id: call._id.toString(),
        creatorId: call.creatorId.toString(),
        scheduledAt: call.scheduledAt.toISOString(),
        durationMinutes: call.durationMinutes,
        status: call.status,
        notes: call.notes,
      },
    });
  } catch (error) {
    if (error instanceof VipSchedulingError) {
      res.status(400).json({ success: false, error: error.message, errorCode: error.code });
      return;
    }
    logError('vip_schedule_call_failed', error);
    res.status(500).json({ success: false, error: 'Failed to schedule call' });
  }
};

export const listScheduledCalls = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (rejectIfVipDisabled(res)) return;

    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const calls = await listCallerScheduledCalls(user._id);
    res.json({
      success: true,
      data: calls.map((c) => ({
        id: c._id.toString(),
        creatorId: c.creatorId.toString(),
        scheduledAt: c.scheduledAt.toISOString(),
        durationMinutes: c.durationMinutes,
        status: c.status,
        notes: c.notes,
      })),
    });
  } catch (error) {
    logError('vip_list_scheduled_failed', error);
    res.status(500).json({ success: false, error: 'Failed to list scheduled calls' });
  }
};

export const listIncomingScheduledCalls = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (rejectIfVipDisabled(res)) return;

    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const creator = await Creator.findOne({ userId: user._id });
    if (!creator) {
      res.status(403).json({ success: false, error: 'Creator profile required' });
      return;
    }

    const calls = await listCreatorIncomingScheduledCalls(creator._id);
    res.json({
      success: true,
      data: calls.map((c) => ({
        id: c._id.toString(),
        callerUserId: c.callerUserId.toString(),
        scheduledAt: c.scheduledAt.toISOString(),
        durationMinutes: c.durationMinutes,
        status: c.status,
        notes: c.notes,
      })),
    });
  } catch (error) {
    logError('vip_list_incoming_scheduled_failed', error);
    res.status(500).json({ success: false, error: 'Failed to list incoming scheduled calls' });
  }
};

export const confirmScheduledCallHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (rejectIfVipDisabled(res)) return;

    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const creator = await Creator.findOne({ userId: user._id });
    if (!creator) {
      res.status(403).json({ success: false, error: 'Creator profile required' });
      return;
    }

    const call = await confirmScheduledCall(req.params.id, creator._id);
    res.json({
      success: true,
      data: {
        id: call._id.toString(),
        status: call.status,
        confirmedAt: call.confirmedAt?.toISOString(),
      },
    });
  } catch (error) {
    if (error instanceof VipSchedulingError) {
      const status = error.code === 'NOT_FOUND' ? 404 : 400;
      res.status(status).json({ success: false, error: error.message, errorCode: error.code });
      return;
    }
    logError('vip_confirm_scheduled_failed', error);
    res.status(500).json({ success: false, error: 'Failed to confirm scheduled call' });
  }
};

export const cancelScheduledCallHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (rejectIfVipDisabled(res)) return;

    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const creator = await Creator.findOne({ userId: user._id });
    const call = await cancelScheduledCall(req.params.id, {
      userId: user._id,
      isCreator: !!creator,
    });

    res.json({
      success: true,
      data: {
        id: call._id.toString(),
        status: call.status,
        cancelledAt: call.cancelledAt?.toISOString(),
      },
    });
  } catch (error) {
    if (error instanceof VipSchedulingError) {
      const status =
        error.code === 'NOT_FOUND' ? 404 : error.code === 'FORBIDDEN' ? 403 : 400;
      res.status(status).json({ success: false, error: error.message, errorCode: error.code });
      return;
    }
    logError('vip_cancel_scheduled_failed', error);
    res.status(500).json({ success: false, error: 'Failed to cancel scheduled call' });
  }
};

export const getCallQueueStatus = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (rejectIfVipDisabled(res)) return;

    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { getCallerQueueStatus } = await import('./vip-call-queue.service');
    const entries = await getCallerQueueStatus(req.auth.firebaseUid);
    res.json({ success: true, data: entries });
  } catch (error) {
    logError('vip_queue_status_failed', error);
    res.status(500).json({ success: false, error: 'Failed to load queue status' });
  }
};

export const leaveCallQueue = async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectIfVipDisabled(res)) return;

    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { creatorFirebaseUid } = req.body as { creatorFirebaseUid?: string };
    if (!creatorFirebaseUid) {
      res.status(400).json({ success: false, error: 'creatorFirebaseUid is required' });
      return;
    }

    const { leaveCallQueue: leaveQueue } = await import('./vip-call-queue.service');
    await leaveQueue(creatorFirebaseUid, req.auth.firebaseUid);
    res.json({ success: true });
  } catch (error) {
    logError('vip_leave_queue_failed', error);
    res.status(500).json({ success: false, error: 'Failed to leave queue' });
  }
};
