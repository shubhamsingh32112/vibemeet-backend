import type { Request } from 'express';
import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getFirebaseAdmin } from '../config/firebase';
import { User } from '../modules/user/user.model';

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

    // --- Try Admin JWT first (short tokens, ~236 chars) ---
    const jwtSecret = process.env.JWT_SECRET;
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
            console.log('✅ [AUTH MIDDLEWARE] Admin JWT verified');
            console.log(`   Admin ID: ${adminUser._id}`);
            console.log(`   Email: ${adminUser.email || 'N/A'}`);

            req.auth = {
              firebaseUid: adminUser.firebaseUid,
              email: adminUser.email,
            };

            console.log('✅ [AUTH MIDDLEWARE] Admin authentication successful');
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
    
    console.log('🔄 [AUTH MIDDLEWARE] Verifying token with Firebase Admin...');
    const decodedToken = await admin.auth().verifyIdToken(token);
    console.log('✅ [AUTH MIDDLEWARE] Firebase token verified');
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
