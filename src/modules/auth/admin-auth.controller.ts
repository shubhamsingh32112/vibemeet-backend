import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../user/user.model';

/**
 * POST /auth/admin-login
 * Direct email/password login for admin website.
 * 
 * Verifies credentials against env vars — NO Firebase Auth involved.
 * Issues a custom JWT for the admin website.
 */

const ADMIN_JWT_SECRET = process.env.JWT_SECRET || process.env.FIREBASE_PROJECT_ID || 'admin-secret-change-me';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@matchvibe.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin@matchvibe';

export const adminLogin = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({
        success: false,
        error: 'Email and password are required',
      });
      return;
    }

    console.log(`🔐 [ADMIN AUTH] Login attempt for: ${email}`);

    // Verify credentials against env vars (no Firebase)
    if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
      console.log(`❌ [ADMIN AUTH] Invalid credentials for: ${email}`);
      res.status(401).json({
        success: false,
        error: 'Invalid email or password',
      });
      return;
    }

    console.log(`✅ [ADMIN AUTH] Credentials verified`);

    // Look up admin user in MongoDB
    let dbUser = await User.findOne({ email: ADMIN_EMAIL, role: 'admin' });

    if (!dbUser) {
      // Auto-create admin user if missing from DB (e.g. fresh database)
      dbUser = await User.create({
        firebaseUid: `admin-${Date.now()}`,
        email: ADMIN_EMAIL,
        role: 'admin',
        categories: ['admin'],
        coins: 0,
        freeTextUsed: 0,
      });
      console.log(`📝 [ADMIN AUTH] Auto-created admin user in DB`);
    }

    // Issue a custom JWT
    const token = jwt.sign(
      {
        uid: dbUser.firebaseUid,
        email: dbUser.email,
        role: 'admin',
        type: 'admin-jwt',
      },
      ADMIN_JWT_SECRET,
      { expiresIn: '24h' }
    );

    console.log(`✅ [ADMIN AUTH] Admin login successful: ${email}`);

    res.json({
      success: true,
      data: {
        token,
        user: {
          id: dbUser._id,
          email: dbUser.email,
          role: dbUser.role,
          firebaseUid: dbUser.firebaseUid,
        },
      },
    });
  } catch (error) {
    console.error('❌ [ADMIN AUTH] Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};
