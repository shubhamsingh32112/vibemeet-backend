import type { Request } from 'express';
import { Response } from 'express';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('🔐 [AUTH] Login request received');
    console.log(`   IP: ${req.ip}`);
    console.log(`   Firebase UID: ${req.auth?.firebaseUid || 'Not provided'}`);
    
    // User is already verified by middleware
    if (!req.auth) {
      console.log('❌ [AUTH] No user in request');
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    console.log(`🔄 [AUTH] Looking up user in database...`);
    console.log(`   Firebase UID: ${req.auth.firebaseUid}`);

    let user = await User.findOne({ firebaseUid: req.auth.firebaseUid });

    // ✅ Create user ONLY here (never in middleware)
    if (!user) {
      console.log('📝 [AUTH] Creating new user in database (first login)...');
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
      console.log('✅ [AUTH] New user created');
      console.log(`   User ID: ${user._id}`);
      console.log(`   Initial coins: 30 (free coins for new users)`);
      console.log(`   Free chats: 3 (freeTextUsed initialized to 0)`);
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

    console.log('✅ [AUTH] User found');
    console.log(`   User ID: ${user._id}`);
    console.log(`   Email: ${user.email || 'N/A'}`);
    console.log(`   Phone: ${user.phone || 'N/A'}`);
    console.log(`   Role: ${user.role}`);
    console.log(`   Coins: ${user.coins}`);

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
          // User-specific data (coins, role, etc.)
          coins: user.coins,
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
            role: user.role,
          },
          creator: null,
          needsOnboarding,
        },
      });
    }
    console.log('✅ [AUTH] Login response sent');
  } catch (error) {
    console.error('❌ [AUTH] Login error:', error);
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
