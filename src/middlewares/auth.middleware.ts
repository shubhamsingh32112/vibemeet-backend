import type { Request } from 'express';
import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getFirebaseAdmin } from '../config/firebase';
import { User } from '../modules/user/user.model';
import { logError, logInfo, logDebug, logWarning } from '../utils/logger';
import {
  isAgencyRole,
  isBdRole,
  isAgencyStaffDisabled,
  isBdStaffDisabled,
  isSuperAdminRole,
} from '../utils/staff-roles';

function jwtRoleMatchesMongoStaff(tokenRole: string, mongoRole: string): boolean {
  if (tokenRole === 'admin' || tokenRole === 'super_admin') {
    return isSuperAdminRole(mongoRole);
  }
  if (tokenRole === 'bd') {
    return isBdRole(mongoRole);
  }
  if (tokenRole === 'agency') {
    return isAgencyRole(mongoRole);
  }
  return false;
}

/**
 * Verifies either a Firebase ID token (mobile app) or a custom admin JWT (admin website).
 * Attaches auth info to req.auth.
 */
export const verifyFirebaseToken = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    logDebug('Verifying token', { path: req.path, ip: req.ip });

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logWarning('No authorization header', { path: req.path, ip: req.ip });
      res.status(401).json({
        success: false,
        error: 'Unauthorized: No token provided',
      });
      return;
    }

    const token = authHeader.split('Bearer ')[1];
    logDebug('Auth token received', { path: req.path });

    const jwtSecret = (process.env.JWT_SECRET || 'admin-secret-change-me').trim();
    if (jwtSecret) {
      try {
        const decoded = jwt.verify(token, jwtSecret) as {
          userId: string;
          role: string;
          email: string;
        };

        if (decoded.userId) {
          const staffUser = await User.findById(decoded.userId);
          if (
            staffUser &&
            jwtRoleMatchesMongoStaff(decoded.role, staffUser.role) &&
            (isSuperAdminRole(staffUser.role) ||
              (isAgencyRole(staffUser.role) && !isAgencyStaffDisabled(staffUser)) ||
              (isBdRole(staffUser.role) && !isBdStaffDisabled(staffUser)))
          ) {
            const kind = isSuperAdminRole(staffUser.role)
              ? 'Admin'
              : isBdRole(staffUser.role)
                ? 'BD'
                : 'Agency';
            logInfo(`${kind} JWT verified`, {
              staffId: staffUser._id.toString(),
              path: req.path,
            });
            req.auth = {
              firebaseUid: staffUser.firebaseUid,
              email: staffUser.email,
            };
            next();
            return;
          }
        }
      } catch {
        // Not a valid admin JWT — fall through to Firebase verification
      }
    }

    const admin = getFirebaseAdmin();

    logDebug('Verifying token with Firebase Admin', { path: req.path });
    const decodedToken = await admin.auth().verifyIdToken(token);
    logInfo('Firebase token verified', {
      firebaseUid: decodedToken.uid,
      path: req.path,
    });

    req.auth = {
      firebaseUid: decodedToken.uid,
      email: decodedToken.email,
      phone: decodedToken.phone_number,
    };

    logInfo('Authentication successful', { path: req.path });
    next();
  } catch (error) {
    logError('Token verification error', error, {
      path: req.path,
      ip: req.ip,
    });
    res.status(401).json({
      success: false,
      error: 'Unauthorized: Invalid or expired token',
    });
  }
};
