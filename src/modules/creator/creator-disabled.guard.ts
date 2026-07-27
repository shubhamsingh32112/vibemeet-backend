import type { Request, Response, NextFunction } from 'express';
import { User } from '../user/user.model';
import { Creator } from './creator.model';
import { isSuperAdminRole } from '../admin/admin-roles';

export const HOST_DISABLED_ERROR_CODE = 'HOST_DISABLED';

export type CreatorDisabledCheck =
  | { ok: true }
  | { ok: false; status: number; error: string; errorCode?: string };

/**
 * Returns a failed check when the creator host account is deactivated by superadmin.
 */
export function assertCreatorNotDisabled(creator: {
  isDisabled?: boolean | null;
} | null | undefined): CreatorDisabledCheck {
  if (creator && creator.isDisabled === true) {
    return {
      ok: false,
      status: 403,
      error:
        'Your host account has been deactivated. Contact your BD or admin for help.',
      errorCode: HOST_DISABLED_ERROR_CODE,
    };
  }
  return { ok: true };
}

export function sendHostDisabled(res: Response): void {
  res.status(403).json({
    success: false,
    error:
      'Your host account has been deactivated. Contact your BD or admin for help.',
    errorCode: HOST_DISABLED_ERROR_CODE,
  });
}

/**
 * Blocks creator-facing host tools when Creator.isDisabled is true.
 * Super admins acting on behalf are not blocked by this middleware.
 */
export async function blockIfHostDisabled(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.auth?.firebaseUid) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid })
      .select('_id role')
      .lean();
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    if (isSuperAdminRole(user.role)) {
      next();
      return;
    }

    if (user.role !== 'creator') {
      next();
      return;
    }

    const creator = await Creator.findOne({ userId: user._id })
      .select('isDisabled')
      .lean();
    if (creator?.isDisabled === true) {
      sendHostDisabled(res);
      return;
    }

    next();
  } catch (err) {
    next(err);
  }
}
