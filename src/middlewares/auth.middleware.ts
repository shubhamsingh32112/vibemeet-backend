import type { Request } from 'express';
import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getFirebaseAdmin } from '../config/firebase';
import { User } from '../modules/user/user.model';
import { logError, logInfo, logDebug, logWarning } from '../utils/logger';

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
    logDebug('Token received', { path: req.path, tokenLength: token.length });

    // --- Try Admin JWT first (short tokens, ~236 chars) ---
    const jwtSecret = (process.env.JWT_SECRET || 'admin-secret-change-me').trim();
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
            logInfo('Admin JWT verified', {
              adminId: adminUser._id.toString(),
              email: adminUser.email || 'N/A',
              path: req.path,
            });

            req.auth = {
              firebaseUid: adminUser.firebaseUid,
              email: adminUser.email,
            };

            logInfo('Admin authentication successful', { path: req.path });
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
    
    logDebug('Verifying token with Firebase Admin', { path: req.path });
    const decodedToken = await admin.auth().verifyIdToken(token);
    logInfo('Firebase token verified', {
      firebaseUid: decodedToken.uid,
      email: decodedToken.email || 'N/A',
      phone: decodedToken.phone_number || 'N/A',
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
