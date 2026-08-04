import { Request, Response } from 'express';
import { User } from '../user/user.model';
import { logError } from '../../utils/logger';
import {
  CheckInError,
  claimDailyCheckIn,
  getCheckInStatusForUser,
} from './checkin.service';
import {
  deleteDevicePushToken,
  upsertDevicePushToken,
} from './device-push-token.service';
import { isDailyCheckInEnabled } from './checkin.config';

function handleCheckInError(res: Response, err: unknown): void {
  if (err instanceof CheckInError) {
    res.status(err.statusCode).json({
      success: false,
      error: err.message,
      code: err.code,
    });
    return;
  }
  logError('Daily check-in error', err as Error);
  res.status(500).json({ success: false, error: 'Internal server error' });
}

export const getCheckInStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth?.firebaseUid) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const data = await getCheckInStatusForUser({ firebaseUid: req.auth.firebaseUid });
    res.json({ success: true, data });
  } catch (err) {
    handleCheckInError(res, err);
  }
};

export const claimCheckIn = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth?.firebaseUid) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const data = await claimDailyCheckIn({ firebaseUid: req.auth.firebaseUid });
    res.json({ success: true, data });
  } catch (err) {
    handleCheckInError(res, err);
  }
};

export const registerPushToken = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth?.firebaseUid) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    const platform = req.body?.platform;
    if (!token || (platform !== 'ios' && platform !== 'android')) {
      res.status(400).json({
        success: false,
        error: 'token (string) and platform (ios|android) are required',
      });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid }).select(
      '_id role'
    );
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    if (user.role !== 'user') {
      // Creators/hosts must not receive check-in reminders; acknowledge without storing.
      res.json({ success: true, data: { registered: false, reason: 'role' } });
      return;
    }
    if (!isDailyCheckInEnabled()) {
      res.json({ success: true, data: { registered: false, reason: 'disabled' } });
      return;
    }

    await upsertDevicePushToken({
      userId: user._id,
      token,
      platform,
    });

    res.json({ success: true, data: { registered: true } });
  } catch (err) {
    handleCheckInError(res, err);
  }
};

export const unregisterPushToken = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth?.firebaseUid) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!token) {
      res.status(400).json({ success: false, error: 'token is required' });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid }).select('_id');
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    await deleteDevicePushToken({ userId: user._id, token });
    res.json({ success: true, data: { unregistered: true } });
  } catch (err) {
    handleCheckInError(res, err);
  }
};
