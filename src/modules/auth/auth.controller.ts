import type { Request } from 'express';
import { Response } from 'express';
import jwt from 'jsonwebtoken';
import { requireEnv } from '../../config/env';
import { authResponseDtoSchema, AuthResponseDto } from '../../contracts/canonical.dto';
import { sendCompatibleResponse } from '../../contracts/compatibility';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { logger } from '../../utils/logger';

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    logger.info('auth.login.request_received', {
      ip: req.ip,
      firebaseUid: req.auth?.firebaseUid || 'Not provided',
    });
    
    // User is already verified by middleware
    if (!req.auth) {
      logger.warn('auth.login.unauthorized_missing_auth');
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    logger.info('auth.login.lookup_user', { firebaseUid: req.auth.firebaseUid });

    let user = await User.findOne({ firebaseUid: req.auth.firebaseUid });

    // ✅ Create user ONLY here (never in middleware)
    if (!user) {
      logger.info('auth.login.creating_new_user');
      // 🔥 CRITICAL: Only regular users get free coins (not creators)
      // New users get 30 free coins and 3 free chats on first login
      // Creators don't need coins to receive calls/texts, so they don't get free coins
      user = await User.create({
        firebaseUid: req.auth.firebaseUid,
        phone: req.auth.phone,
        email: req.auth.email,
        role: 'user', // Default to 'user' - creators are promoted later via admin
        categories: [], // onboarding pending
        coins: 30, // ✅ New users get 30 free coins on first login (only for regular users)
        freeTextUsed: 0, // ✅ Initialize free text counter (3 free chats for new users)
      });
      logger.info('auth.login.new_user_created', { userId: user._id.toString() });
    } else {
      // Keep user contact info in sync (DB writes are OK here)
      const needsUpdate =
        (req.auth.email && user.email !== req.auth.email) ||
        (req.auth.phone && user.phone !== req.auth.phone);

      if (needsUpdate) {
        if (req.auth.email) user.email = req.auth.email;
        if (req.auth.phone) user.phone = req.auth.phone;
        await user.save();
      }
    }

    logger.info('auth.login.user_ready', {
      userId: user._id.toString(),
      role: user.role,
      coins: user.coins,
    });

    // Pure read - check if user has a creator profile (no auto-linking, no role mutation)
    const creator = await Creator.findOne({ userId: user._id });

    const needsOnboarding = (user.categories ?? []).length === 0;

    // If creator exists, return creator details as primary data
    if (creator) {
      const legacyData = {
        // Primary data from creator collection
        id: creator._id.toString(),
        name: creator.name,
        about: creator.about,
        photo: creator.photo,
        email: user.email, // Use user's email (identity comes from user)
        phone: user.phone, // Use user's phone (identity comes from user)
        categories: creator.categories,
        price: creator.price,
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
      };

      const normalizedData: AuthResponseDto = {
        session: {
          authenticated: true,
          needsOnboarding: false,
        },
        user: {
          id: user._id.toString(),
          firebaseUid: user.firebaseUid,
          role: user.role,
          email: user.email ?? null,
          phone: user.phone ?? null,
          gender: user.gender ?? null,
          username: user.username ?? null,
          avatar: user.avatar ?? null,
          categories: user.categories ?? [],
          coins: user.coins,
          welcomeBonusClaimed: Boolean(user.welcomeBonusClaimed),
          usernameChangeCount: user.usernameChangeCount,
          createdAt: user.createdAt?.toISOString(),
          updatedAt: user.updatedAt?.toISOString(),
        },
        creator: {
          id: creator._id.toString(),
          userId: creator.userId?.toString() ?? null,
          name: creator.name,
          about: creator.about,
          photo: creator.photo,
          categories: creator.categories ?? [],
          price: creator.price,
          isOnline: creator.isOnline,
          createdAt: creator.createdAt?.toISOString(),
          updatedAt: creator.updatedAt?.toISOString(),
        },
      };

      sendCompatibleResponse({
        req,
        res,
        legacyData,
        normalizedData,
        validator: authResponseDtoSchema,
        deprecations: ['`data.id` + flat creator/user fields are legacy; migrate to `normalized.user` and `normalized.creator`.'],
      });
    } else {
      // Regular user login
      const legacyData = {
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
      };
      const normalizedData: AuthResponseDto = {
        session: {
          authenticated: true,
          needsOnboarding,
        },
        user: {
          id: user._id.toString(),
          firebaseUid: user.firebaseUid,
          role: user.role,
          email: user.email ?? null,
          phone: user.phone ?? null,
          gender: user.gender ?? null,
          username: user.username ?? null,
          avatar: user.avatar ?? null,
          categories: user.categories ?? [],
          coins: user.coins,
          welcomeBonusClaimed: Boolean(user.welcomeBonusClaimed),
          usernameChangeCount: user.usernameChangeCount,
          createdAt: user.createdAt?.toISOString(),
          updatedAt: user.updatedAt?.toISOString(),
        },
        creator: null,
      };

      sendCompatibleResponse({
        req,
        res,
        legacyData,
        normalizedData,
        validator: authResponseDtoSchema,
        deprecations: ['`data.user`/`data.creator` stays supported during migration; adopt `normalized` contract.'],
      });
    }
    logger.info('auth.login.response_sent');
  } catch (error) {
    logger.error('auth.login.failed', { error });
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
    console.error('Logout error:', error);
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
 * and returns a custom JWT.
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
    const adminEmail = requireEnv('ADMIN_EMAIL');
    const adminPassword = requireEnv('ADMIN_PASSWORD');
    const jwtSecret = requireEnv('JWT_SECRET');

    logger.info('auth.admin_login.attempt', { email });

    if (email !== adminEmail || password !== adminPassword) {
      logger.warn('auth.admin_login.invalid_credentials', { email });
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
      logger.warn('auth.admin_login.admin_user_bootstrapped', { email: adminEmail });
    }

    const token = jwt.sign(
      { userId: adminUser._id.toString(), role: 'admin', email: adminEmail },
      jwtSecret,
      { expiresIn: '7d' },
    );

    logger.info('auth.admin_login.success', { email });

    const legacyData = {
      token,
      user: {
        id: adminUser._id.toString(),
        email: adminUser.email,
        role: adminUser.role,
      },
    };
    const normalizedData: AuthResponseDto = {
      session: {
        authenticated: true,
        needsOnboarding: false,
      },
      user: {
        id: adminUser._id.toString(),
        firebaseUid: adminUser.firebaseUid,
        role: adminUser.role,
        email: adminUser.email ?? null,
        phone: adminUser.phone ?? null,
        gender: adminUser.gender ?? null,
        username: adminUser.username ?? null,
        avatar: adminUser.avatar ?? null,
        categories: adminUser.categories ?? [],
        coins: adminUser.coins ?? 0,
        welcomeBonusClaimed: Boolean(adminUser.welcomeBonusClaimed),
        usernameChangeCount: adminUser.usernameChangeCount ?? 0,
        createdAt: adminUser.createdAt?.toISOString(),
        updatedAt: adminUser.updatedAt?.toISOString(),
      },
      creator: null,
      adminToken: token,
    };

    sendCompatibleResponse({
      req,
      res,
      legacyData,
      normalizedData,
      validator: authResponseDtoSchema,
      deprecations: ['Legacy admin token field remains at `data.token`; normalized field is `normalized.adminToken`.'],
    });
  } catch (error) {
    logger.error('auth.admin_login.failed', { error });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
