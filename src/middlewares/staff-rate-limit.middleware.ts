import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { StaffRateLimitIdentity } from './rate-limit.middleware';

declare global {
  namespace Express {
    interface Request {
      staffRateLimit?: StaffRateLimitIdentity;
    }
  }
}

/**
 * Lightweight JWT decode for rate-limit keying only (no DB verify).
 * Runs before general rate limiter so staff behind shared NAT get per-user buckets.
 */
export function attachStaffRateLimitIdentity(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
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
    const decoded = jwt.verify(token, jwtSecret) as { userId?: string; role?: string };
    if (decoded.userId && decoded.role) {
      req.staffRateLimit = { userId: decoded.userId, role: decoded.role };
    }
  } catch {
    /* Firebase tokens fall through to IP bucket */
  }
  next();
}
