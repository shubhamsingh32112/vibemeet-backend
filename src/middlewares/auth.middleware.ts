import type { Request } from 'express';
import { Response, NextFunction } from 'express';
import { getFirebaseAdmin } from '../config/firebase';

export const verifyFirebaseToken = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    console.log('🔐 [AUTH MIDDLEWARE] Verifying Firebase token...');
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
