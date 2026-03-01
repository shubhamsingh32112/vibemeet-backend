import type { Request } from 'express';
import { Response } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { DeletedUserPhone } from '../user/deleted-user-phone.model';
import { logInfo, logError, logDebug } from '../../utils/logger';

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    logDebug('Login request received', {
      ip: req.ip,
      firebaseUid: req.auth?.firebaseUid || 'not-provided',
    });
    
    // User is already verified by middleware
    if (!req.auth) {
      logInfo('Login failed: no user in request', { ip: req.ip });
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    const firebaseUid = req.auth.firebaseUid;
    logDebug('Looking up user in database', { firebaseUid });

    let user = await User.findOne({ firebaseUid });

      // ✅ Create user ONLY here (never in middleware)
      if (!user) {
        logInfo('Creating new user (first login)', { firebaseUid });
        
        // Check if this phone number was previously deleted and had claimed welcome bonus
        let welcomeBonusClaimed = false;
        if (req.auth.phone) {
          const deletedPhone = await DeletedUserPhone.findOne({ phone: req.auth.phone });
          if (deletedPhone && deletedPhone.welcomeBonusClaimed) {
            welcomeBonusClaimed = true;
            logInfo('Phone number found in deleted users - welcome bonus already claimed', {
              phone: req.auth.phone,
              deletedAt: deletedPhone.deletedAt,
            });
          }
        }
        
        // 🔥 CRITICAL: Only regular users can claim welcome bonus (not creators)
        // New users start with 0 coins - they get 30 free coins when they accept the welcome bonus popup
        // Creators don't need coins to receive calls/texts, so they don't get free coins
        user = await User.create({
          firebaseUid: req.auth.firebaseUid,
          phone: req.auth.phone,
          email: req.auth.email,
          role: 'user', // Default to 'user' - creators are promoted later via admin
          categories: [], // onboarding pending
          coins: 0, // ✅ New users start with 0 coins - 30 coins are added when they accept the welcome bonus popup
          freeTextUsed: 0, // ✅ Initialize free text counter (3 free chats for new users)
          welcomeBonusClaimed: welcomeBonusClaimed, // ✅ Set to true if phone number previously claimed bonus
        });
        logInfo('New user created', {
          userId: user._id.toString(),
          firebaseUid,
          initialCoins: 0,
          freeTextUsed: 0,
          welcomeBonusClaimed: welcomeBonusClaimed,
        });
    } else {
      // Keep user contact info in sync (DB writes are OK here)
      const needsUpdate =
        (req.auth.email && user.email !== req.auth.email) ||
        (req.auth.phone && user.phone !== req.auth.phone);

      if (needsUpdate) {
        if (req.auth.email) user.email = req.auth.email;
        if (req.auth.phone) user.phone = req.auth.phone;
        await user.save();
        logDebug('User contact info updated', { userId: user._id.toString() });
      }
    }

    logInfo('User login successful', {
      userId: user._id.toString(),
      firebaseUid,
      email: user.email || null,
      phone: user.phone || null,
      role: user.role,
      coins: user.coins,
    });

    // Pure read - check if user has a creator profile (no auto-linking, no role mutation)
    const creator = await Creator.findOne({ userId: user._id });

    const needsOnboarding = (user.categories ?? []).length === 0;

    // If creator exists, return creator details as primary data
    if (creator) {
      res.json({
        success: true,
        data: {
          // Primary data from creator collection
          id: creator._id.toString(),
          name: creator.name,
          about: creator.about,
          photo: creator.photo,
          email: user.email, // Use user's email (identity comes from user)
          phone: user.phone, // Use user's phone (identity comes from user)
          categories: creator.categories,
          price: creator.price,
          age: creator.age,
          // User-specific data (coins, role, etc.)
          coins: user.coins,
          welcomeBonusClaimed: user.welcomeBonusClaimed,
          role: user.role,
          userId: user._id.toString(), // Reference to user document
          // Additional user fields that might be useful
          gender: user.gender,
          username: user.username,
          avatar: user.avatar,
          usernameChangeCount: user.usernameChangeCount,
          createdAt: creator.createdAt,
          updatedAt: creator.updatedAt,
          needsOnboarding: false, // Creators don't need onboarding
        },
      });
    } else {
      // Regular user login
      res.json({
        success: true,
        data: {
          user: {
            id: user._id.toString(),
            email: user.email,
            phone: user.phone,
            gender: user.gender,
            username: user.username,
            avatar: user.avatar,
            categories: user.categories,
            usernameChangeCount: user.usernameChangeCount,
            coins: user.coins,
            welcomeBonusClaimed: user.welcomeBonusClaimed,
            role: user.role,
          },
          creator: null,
          needsOnboarding,
        },
      });
    }
  } catch (error) {
    logError('Login error', error, {
      firebaseUid: req.auth?.firebaseUid,
      ip: req.ip,
    });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

export const logout = async (_req: Request, res: Response): Promise<void> => {
  try {
    // For Firebase, logout is handled client-side
    // This endpoint can be used for server-side cleanup if needed
    res.json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    logError('Logout error', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

/**
 * Admin login — plain email + password (NO Firebase involved).
 *
 * Checks credentials against ADMIN_EMAIL / ADMIN_PASSWORD env vars
 * (with sensible defaults) and returns a custom JWT.
 */
export const adminLogin = async (req: Request, res: Response): Promise<void> => {
  try {
    const email = (req.body.email ?? '').trim();
    const password = (req.body.password ?? '').trim();

    if (!email || !password) {
      res.status(400).json({ success: false, error: 'Email and password are required' });
      return;
    }

    // Read credentials from env (trimmed to avoid \r / whitespace issues on Windows)
    const adminEmail = (process.env.ADMIN_EMAIL || 'admin@matchvibe.com').trim();
    const adminPassword = (process.env.ADMIN_PASSWORD || 'admin@matchvibe').trim();
    const jwtSecret = (process.env.JWT_SECRET || 'admin-secret-change-me').trim();

    logDebug('Admin login attempt', { email });

    if (email !== adminEmail || password !== adminPassword) {
      logInfo('Admin login failed: invalid credentials', { email, ip: req.ip });
      res.status(401).json({ success: false, error: 'Invalid email or password' });
      return;
    }

    // Look up (or create) the admin user in the database
    let adminUser = await User.findOne({ email: adminEmail, role: 'admin' });

    if (!adminUser) {
      adminUser = await User.create({
        firebaseUid: `admin_${Date.now()}`,
        email: adminEmail,
        role: 'admin',
        coins: 0,
      });
      logInfo('Admin user created in database', { userId: adminUser._id.toString(), email: adminEmail });
    }

    const token = jwt.sign(
      { userId: adminUser._id.toString(), role: 'admin', email: adminEmail },
      jwtSecret,
      { expiresIn: '7d' },
    );

    logInfo('Admin login successful', {
      userId: adminUser._id.toString(),
      email: adminEmail,
      ip: req.ip,
    });

    res.json({
      success: true,
      data: {
        token,
        user: {
          id: adminUser._id.toString(),
          email: adminUser.email,
          role: adminUser.role,
        },
      },
    });
  } catch (error) {
    logError('Admin login error', error, {
      email: req.body.email,
      ip: req.ip,
    });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
