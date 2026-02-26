import type { Request } from 'express';
import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { requireEnv } from '../config/env';
import { featureFlags } from '../config/feature-flags';
import { getFirebaseAdmin } from '../config/firebase';
import { User } from '../modules/user/user.model';
import { logger } from '../utils/logger';

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
    logger.info('auth.middleware.verify.started', { path: req.path, ip: req.ip });

    if (featureFlags.authBypassForTests) {
      const testFirebaseUid = (req.header('x-test-firebase-uid') || '').trim();
      if (testFirebaseUid) {
        req.auth = {
          firebaseUid: testFirebaseUid,
          email: req.header('x-test-email') || undefined,
        };
        logger.warn('auth.middleware.test_bypass.used', { firebaseUid: testFirebaseUid });
        next();
        return;
      }
    }

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.warn('auth.middleware.verify.missing_header');
      res.status(401).json({
        success: false,
        error: 'Unauthorized: No token provided',
      });
      return;
    }

    const token = authHeader.split('Bearer ')[1];
    logger.debug('auth.middleware.verify.token_received', { tokenLength: token.length });

    // --- Try Admin JWT first (short tokens, ~236 chars) ---
    const jwtSecret = requireEnv('JWT_SECRET');
    if (jwtSecret) {
      try {
        const decoded = jwt.verify(token, jwtSecret) as {
          userId: string;
          role: string;
          email: string;
        };

        if (decoded.role === 'admin' && decoded.userId) {
          // Look up the admin user to get their firebaseUid
          const adminUser = await User.findById(decoded.userId);
          if (adminUser && adminUser.role === 'admin') {
            logger.info('auth.middleware.verify.admin_jwt_success', {
              adminId: adminUser._id.toString(),
              email: adminUser.email || 'N/A',
            });

            req.auth = {
              firebaseUid: adminUser.firebaseUid,
              email: adminUser.email,
            };

            next();
            return;
          }
        }
      } catch {
        // Not a valid admin JWT — fall through to Firebase verification
      }
    }

    // --- Firebase ID token verification (Flutter app) ---
    const admin = getFirebaseAdmin();

    logger.info('auth.middleware.verify.firebase_verification_started');
    const decodedToken = await admin.auth().verifyIdToken(token);
    logger.info('auth.middleware.verify.firebase_success', {
      firebaseUid: decodedToken.uid,
      email: decodedToken.email || 'N/A',
      phone: decodedToken.phone_number || 'N/A',
    });

    req.auth = {
      firebaseUid: decodedToken.uid,
      email: decodedToken.email,
      phone: decodedToken.phone_number,
    };

    next();
  } catch (error) {
    logger.error('auth.middleware.verify.failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    });
    res.status(401).json({
      success: false,
      error: 'Unauthorized: Invalid or expired token',
    });
  }
};
