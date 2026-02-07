import type { Request } from 'express';
import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getFirebaseAdmin } from '../config/firebase';

const ADMIN_JWT_SECRET = process.env.JWT_SECRET || process.env.FIREBASE_PROJECT_ID || 'admin-secret-change-me';

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
    console.log('🔐 [AUTH MIDDLEWARE] Verifying token...');
    console.log(`   Path: ${req.path}`);
    console.log(`   IP: ${req.ip}`);
    
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log('❌ [AUTH MIDDLEWARE] No authorization header');
      res.status(401).json({
        success: false,
        error: 'Unauthorized: No token provided',
      });
      return;
    }

    const token = authHeader.split('Bearer ')[1];
    console.log(`   Token length: ${token.length} characters`);

    // Try to decode as custom admin JWT first (fast, no network call)
    try {
      const decoded = jwt.verify(token, ADMIN_JWT_SECRET) as any;
      if (decoded.type === 'admin-jwt') {
        console.log('✅ [AUTH MIDDLEWARE] Admin JWT verified');
        console.log(`   Firebase UID: ${decoded.uid}`);
        console.log(`   Email: ${decoded.email || 'N/A'}`);
        console.log(`   Role: ${decoded.role}`);

        req.auth = {
          firebaseUid: decoded.uid,
          email: decoded.email,
        };

        console.log('✅ [AUTH MIDDLEWARE] Authentication successful (admin JWT)');
        next();
        return;
      }
    } catch {
      // Not an admin JWT — fall through to Firebase token verification
    }

    // Verify as Firebase ID token (mobile app flow)
    const admin = getFirebaseAdmin();
    
    console.log('🔄 [AUTH MIDDLEWARE] Verifying token with Firebase Admin...');
    const decodedToken = await admin.auth().verifyIdToken(token);
    console.log('✅ [AUTH MIDDLEWARE] Token verified');
    console.log(`   Firebase UID: ${decodedToken.uid}`);
    console.log(`   Email: ${decodedToken.email || 'N/A'}`);
    console.log(`   Phone: ${decodedToken.phone_number || 'N/A'}`);

    req.auth = {
      firebaseUid: decodedToken.uid,
      email: decodedToken.email,
      phone: decodedToken.phone_number,
    };

    console.log('✅ [AUTH MIDDLEWARE] Authentication successful');
    next();
  } catch (error) {
    console.error('❌ [AUTH MIDDLEWARE] Token verification error:', error);
    if (error instanceof Error) {
      console.error(`   Error message: ${error.message}`);
      console.error(`   Error stack: ${error.stack}`);
    }
    res.status(401).json({
      success: false,
      error: 'Unauthorized: Invalid or expired token',
    });
  }
};
