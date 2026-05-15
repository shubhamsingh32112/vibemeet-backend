import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getFirebaseAdmin } from '../config/firebase';

declare global {
  namespace Express {
    interface Request {
      /** Firebase UID for per-user API rate-limit keying (mobile app tokens). */
      firebaseRateLimitUid?: string;
    }
  }
}

/**
 * Lightweight Firebase token verify for rate-limit keying only.
 * Runs before the general rate limiter (which executes before route auth).
 * Staff JWTs are handled separately by attachStaffRateLimitIdentity.
 */
export async function attachFirebaseRateLimitIdentity(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      next();
      return;
    }
    const token = authHeader.split('Bearer ')[1]?.trim();
    if (!token) {
      next();
      return;
    }

    const jwtSecret = (process.env.JWT_SECRET || 'admin-secret-change-me').trim();
    if (jwtSecret) {
      try {
        jwt.verify(token, jwtSecret);
        // Valid staff JWT — staffRateLimit middleware owns the bucket key.
        next();
        return;
      } catch {
        // Not a staff JWT — fall through to Firebase.
      }
    }

    const admin = getFirebaseAdmin();
    const decoded = await admin.auth().verifyIdToken(token);
    if (decoded.uid) {
      req.firebaseRateLimitUid = decoded.uid;
    }
  } catch {
    // Invalid/expired token — fall through to IP bucket until route auth rejects.
  }
  next();
}
