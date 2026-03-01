import type { Request } from 'express';
import { Response } from 'express';
import mongoose from 'mongoose';
import { User } from './user.model';
import { Creator } from '../creator/creator.model';
import { CoinTransaction } from './coin-transaction.model';
import { CallHistory } from '../billing/call-history.model';
import { DeletedUserPhone } from './deleted-user-phone.model';
import { randomUUID } from 'crypto';
import { invalidateAdminCaches } from '../../config/redis';
import { getIO } from '../../config/socket';
import { verifyUserBalance } from '../../utils/balance-integrity';
import { getFirebaseAdmin } from '../../config/firebase';

export const getFavoriteCreators = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    // Only regular users can manage favorites
    if (user.role !== 'user') {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Only users can favorite creators',
      });
      return;
    }

    const favoriteIds = (user.favoriteCreatorIds || []).map((id) => id.toString());

    res.json({
      success: true,
      data: {
        favoriteCreatorIds: favoriteIds,
      },
    });
  } catch (error) {
    console.error('❌ [USER] Get favorites error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const toggleFavoriteCreator = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { creatorId } = req.params;
    if (!creatorId || !mongoose.Types.ObjectId.isValid(creatorId)) {
      res.status(400).json({ success: false, error: 'Invalid creatorId' });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    // Only regular users can manage favorites
    if (user.role !== 'user') {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Only users can favorite creators',
      });
      return;
    }

    // Ensure creator exists (can be offline; favorites are independent of online status)
    const creatorExists = await Creator.exists({ _id: creatorId });
    if (!creatorExists) {
      res.status(404).json({ success: false, error: 'Creator not found' });
      return;
    }

    const creatorObjectId = new mongoose.Types.ObjectId(creatorId);
    const current = (user.favoriteCreatorIds || []).map((id) => id.toString());

    const isCurrentlyFavorite = current.includes(creatorId);
    if (isCurrentlyFavorite) {
      user.favoriteCreatorIds = user.favoriteCreatorIds.filter((id) => id.toString() !== creatorId);
    } else {
      user.favoriteCreatorIds = [...(user.favoriteCreatorIds || []), creatorObjectId];
    }

    await user.save();

    const favoriteIds = (user.favoriteCreatorIds || []).map((id) => id.toString());
    res.json({
      success: true,
      data: {
        isFavorite: !isCurrentlyFavorite,
        favoriteCreatorIds: favoriteIds,
      },
    });
  } catch (error) {
    console.error('❌ [USER] Toggle favorite error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const toggleBlockCreator = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { creatorId, userId, firebaseUid } = req.body; // Accept creatorId, userId, or firebaseUid

    let creator;
    let creatorIdToUse: string;

    // Strategy 1: If creatorId is provided, use it directly
    if (creatorId && mongoose.Types.ObjectId.isValid(creatorId)) {
      creator = await Creator.findById(creatorId);
      if (!creator) {
        console.log(`❌ [USER] Creator not found by creatorId: ${creatorId}`);
        res.status(404).json({ success: false, error: 'Creator not found' });
        return;
      }
      creatorIdToUse = creatorId;
      console.log(`✅ [USER] Found creator by creatorId: ${creatorIdToUse}`);
    } 
    // Strategy 2: If firebaseUid is provided, find user then creator
    else if (firebaseUid && typeof firebaseUid === 'string') {
      const user = await User.findOne({ firebaseUid: firebaseUid });
      if (!user) {
        console.log(`❌ [USER] User not found for firebaseUid: ${firebaseUid}`);
        res.status(404).json({ success: false, error: 'User not found' });
        return;
      }
      creator = await Creator.findOne({ userId: user._id });
      if (!creator) {
        console.log(`❌ [USER] Creator not found for user firebaseUid: ${firebaseUid}, userId: ${user._id}`);
        res.status(404).json({ success: false, error: 'Creator not found for this user' });
        return;
      }
      creatorIdToUse = creator._id.toString();
      console.log(`✅ [USER] Found creator ${creatorIdToUse} for firebaseUid: ${firebaseUid}`);
    }
    // Strategy 3: If userId is provided, try as Creator ID first, then as User ID
    else if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      // First, try to find creator directly by this ID (in case it's actually a creator ID)
      creator = await Creator.findById(userId);
      if (creator) {
        creatorIdToUse = creator._id.toString();
        console.log(`✅ [USER] Found creator by treating userId as creatorId: ${creatorIdToUse}`);
      } else {
        // If not found, try to find creator by userId (User's MongoDB ID)
        const userIdObjectId = new mongoose.Types.ObjectId(userId);
        creator = await Creator.findOne({ userId: userIdObjectId });
        if (!creator) {
          console.log(`❌ [USER] Creator not found for userId: ${userId}`);
          // Log additional debug info
          const userExists = await User.findById(userId);
          console.log(`   [USER] User exists: ${userExists ? 'yes' : 'no'}, role: ${userExists?.role}`);
          res.status(404).json({ success: false, error: 'Creator not found for this user' });
          return;
        }
        creatorIdToUse = creator._id.toString();
        console.log(`✅ [USER] Found creator ${creatorIdToUse} for userId: ${userId}`);
      }
    } 
    else {
      console.log(`❌ [USER] Invalid creatorId, userId, or firebaseUid provided:`, { creatorId, userId, firebaseUid });
      res.status(400).json({ success: false, error: 'Invalid creatorId, userId, or firebaseUid' });
      return;
    }

    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    // Only regular users can block creators
    if (currentUser.role !== 'user') {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Only users can block creators',
      });
      return;
    }

    const creatorObjectId = new mongoose.Types.ObjectId(creatorIdToUse);
    const current = (currentUser.blockedCreatorIds || []).map((id) => id.toString());

    const isCurrentlyBlocked = current.includes(creatorIdToUse);
    if (isCurrentlyBlocked) {
      // Unblock: remove from blocked list
      currentUser.blockedCreatorIds = currentUser.blockedCreatorIds.filter((id) => id.toString() !== creatorIdToUse);
      console.log(`✅ [USER] Creator unblocked: ${creatorIdToUse} by user ${currentUser._id}`);
    } else {
      // Block: add to blocked list
      currentUser.blockedCreatorIds = [...(currentUser.blockedCreatorIds || []), creatorObjectId];
      // Also remove from favorites if present
      currentUser.favoriteCreatorIds = currentUser.favoriteCreatorIds.filter((id) => id.toString() !== creatorIdToUse);
      console.log(`🚫 [USER] Creator blocked: ${creatorIdToUse} by user ${currentUser._id}`);
    }

    await currentUser.save();

    const blockedIds = (currentUser.blockedCreatorIds || []).map((id) => id.toString());
    res.json({
      success: true,
      data: {
        isBlocked: !isCurrentlyBlocked,
        blockedCreatorIds: blockedIds,
      },
    });
  } catch (error) {
    console.error('❌ [USER] Toggle block creator error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getBlockedCreatorsCount = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    // This count is shown in account settings for regular users.
    const blockedCreatorCount = (user.blockedCreatorIds || []).length;

    res.json({
      success: true,
      data: {
        blockedCreatorCount,
      },
    });
  } catch (error) {
    console.error('❌ [USER] Get blocked creators count error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const deleteAccount = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { reasons, note } = req.body as { reasons?: unknown; note?: unknown };
    const reasonList = Array.isArray(reasons)
      ? reasons.filter((r): r is string => typeof r === 'string' && r.trim().length > 0).map((r) => r.trim())
      : [];

    if (reasonList.length === 0) {
      res.status(400).json({ success: false, error: 'Please select at least one reason' });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const creator = await Creator.findOne({ userId: user._id });

    // Log deletion request details for audit/debug visibility.
    console.log('🗑️ [USER] Delete account request accepted');
    console.log(`   User ID: ${user._id.toString()}`);
    console.log(`   Firebase UID: ${user.firebaseUid}`);
    console.log(`   Role: ${user.role}`);
    console.log(`   Reasons: ${reasonList.join(', ')}`);
    if (typeof note === 'string' && note.trim()) {
      console.log(`   Note: ${note.trim()}`);
    }

    // Store phone number before deletion to prevent welcome bonus abuse
    if (user.phone) {
      try {
        // Upsert: update if exists, create if not
        await DeletedUserPhone.findOneAndUpdate(
          { phone: user.phone },
          {
            phone: user.phone,
            welcomeBonusClaimed: user.welcomeBonusClaimed || false,
            deletedAt: new Date(),
          },
          { upsert: true, new: true }
        );
        console.log(`📝 [USER] Stored phone number for deleted account: ${user.phone} (welcomeBonusClaimed: ${user.welcomeBonusClaimed})`);
      } catch (phoneError) {
        console.error('⚠️ [USER] Failed to store deleted user phone:', phoneError);
        // Continue with deletion even if phone storage fails
      }
    }

    await Promise.all([
      CoinTransaction.deleteMany({ userId: user._id }),
      CallHistory.deleteMany({ ownerUserId: user._id }),
      creator ? Creator.deleteOne({ _id: creator._id }) : Promise.resolve(),
      User.deleteOne({ _id: user._id }),
    ]);

    try {
      const firebaseAdmin = getFirebaseAdmin();
      await firebaseAdmin.auth().deleteUser(user.firebaseUid);
      console.log(`✅ [USER] Firebase account deleted: ${user.firebaseUid}`);
    } catch (firebaseError) {
      console.error('⚠️ [USER] Failed to delete Firebase auth user:', firebaseError);
      // Data is already removed from DB. Return success and log this for ops follow-up.
    }

    res.json({
      success: true,
      data: {
        message: 'Account deleted successfully',
      },
    });
  } catch (error) {
    console.error('❌ [USER] Delete account error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getMe = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });

    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found. Call POST /auth/login once to create the user.',
      });
      return;
    }

    // Pure read - check if user has a creator profile (no auto-linking, no role mutation)
    const creator = await Creator.findOne({ userId: user._id });

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
          age: creator.age, // Include age field
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
          blockedCreatorCount: (user.blockedCreatorIds || []).length,
          createdAt: creator.createdAt,
          updatedAt: creator.updatedAt,
        },
      });
    } else {
      // Regular user
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
            blockedCreatorCount: (user.blockedCreatorIds || []).length,
            role: user.role,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
          },
          creator: null,
        },
      });
    }
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// Get all users (for creators to see - excludes other creators)
export const getAllUsers = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('📋 [USER] Get all users request');
    
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    // Get current user to check role
    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      console.log('❌ [USER] Current user not found');
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    console.log(`👤 [USER] Current user role: ${currentUser.role}`);

    // Only creators can see users
    if (currentUser.role !== 'creator' && currentUser.role !== 'admin') {
      console.log('❌ [USER] Forbidden: User is not a creator or admin');
      res.status(403).json({
        success: false,
        error: 'Forbidden: Only creators can view users',
      });
      return;
    }

    // Debug: Check all users in database
    const allUsersDebug = await User.find({}).select('firebaseUid role username').limit(10);
    console.log(`🔍 [USER] Debug - All users in DB (first 10):`);
    allUsersDebug.forEach((u) => {
      console.log(`   - ${u.firebaseUid}: role=${u.role}, username=${u.username || 'N/A'}`);
    });

    // Get all users who are not creators (role === 'user' or role is null/undefined)
    // Exclude the current user
    // Note: Users created before role field was added might have null role
    const users = await User.find({
      $or: [
        { role: 'user' },
        { role: { $exists: false } },
        { role: null },
      ],
      firebaseUid: { $ne: req.auth.firebaseUid },
    })
      .select('username avatar gender categories createdAt firebaseUid')
      .sort({ createdAt: -1 });

    console.log(`✅ [USER] Found ${users.length} users with role 'user'`);

    res.json({
      success: true,
      data: {
        users: users.map((user) => ({
          id: user._id.toString(),
          username: user.username,
          avatar: user.avatar,
          gender: user.gender,
          categories: user.categories || [],
          firebaseUid: user.firebaseUid, // Include firebaseUid for video calls
          createdAt: user.createdAt,
        })),
      },
    });
  } catch (error) {
    console.error('❌ [USER] Get all users error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// Search users for admin (Admin only)
export const searchUsers = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('🔍 [USER] Search users request (admin)');
    
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    // Check if user is admin
    const adminUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!adminUser || adminUser.role !== 'admin') {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Admin access required',
      });
      return;
    }

    const { query, role } = req.query;
    const searchQuery = query as string | undefined;
    const roleFilter = role as string | undefined;

    // Build search filter
    const filter: any = {};
    
    // Role filter (default for admin: show all users)
    if (roleFilter === 'all' || !roleFilter) {
      // Show all users (admin default)
    } else if (roleFilter === 'creator') {
      filter.role = 'creator';
    } else if (roleFilter === 'user') {
      // Show only regular users (for promotion flow)
      filter.$or = [
        { role: 'user' },
        { role: { $exists: false } },
        { role: null },
      ];
    }

    // Text search (username, email, phone)
    if (searchQuery && searchQuery.trim()) {
      const searchRegex = new RegExp(searchQuery.trim(), 'i');
      // If we already have $or from role filter, merge; otherwise create new
      if (filter.$or) {
        filter.$and = [
          { $or: filter.$or },
          {
            $or: [
              { username: searchRegex },
              { email: searchRegex },
              { phone: searchRegex },
            ],
          },
        ];
        delete filter.$or;
      } else {
        filter.$or = [
          { username: searchRegex },
          { email: searchRegex },
          { phone: searchRegex },
        ];
      }
    }

    const users = await User.find(filter)
      .select('username email phone role avatar createdAt')
      .sort({ createdAt: -1 })
      .limit(100); // Increased limit for admin view

    // Check which users already have creator profiles
    const userIds = users.map(u => u._id);
    const existingCreators = await Creator.find({ userId: { $in: userIds } })
      .select('userId')
      .lean();
    const creatorUserIds = new Set(existingCreators.map(c => c.userId.toString()));

    res.json({
      success: true,
      data: {
        users: users.map((user) => ({
          id: user._id.toString(),
          username: user.username,
          email: user.email,
          phone: user.phone,
          role: user.role,
          avatar: user.avatar,
          createdAt: user.createdAt,
          isCreator: creatorUserIds.has(user._id.toString()), // Flag for UI
        })),
      },
    });
  } catch (error) {
    console.error('❌ [USER] Search users error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// Promote user to creator (Admin only) - Single atomic action
export const promoteToCreator = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { name, about, photo, categories, price } = req.body;
    
    console.log(`🎭 [USER] Promote user to creator: ${id}`);
    
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    // Check if user is admin
    const adminUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!adminUser || adminUser.role !== 'admin') {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Admin access required',
      });
      return;
    }

    // Validate required fields
    if (!name || !about || !photo || price === undefined) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: name, about, photo, price',
      });
      return;
    }

    if (categories !== undefined && (!Array.isArray(categories) || categories.some((c) => typeof c !== 'string'))) {
      res.status(400).json({
        success: false,
        error: 'Categories must be an array of strings',
      });
      return;
    }

    if (typeof price !== 'number' || price < 0) {
      res.status(400).json({
        success: false,
        error: 'Price must be a non-negative number',
      });
      return;
    }

    // Find target user
    const targetUser = await User.findById(id);
    if (!targetUser) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    // Check if user is already a creator
    if (targetUser.role === 'creator') {
      const existingCreator = await Creator.findOne({ userId: targetUser._id });
      if (existingCreator) {
        res.status(409).json({
          success: false,
          error: 'User is already a creator',
        });
        return;
      }
    }

    // Check if creator profile already exists for this user
    const existingCreator = await Creator.findOne({ userId: targetUser._id });
    if (existingCreator) {
      res.status(409).json({
        success: false,
        error: 'Creator profile already exists for this user',
      });
      return;
    }

    // Atomic operation: Update role + Create creator profile (using transaction)
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Update user role within transaction
      targetUser.role = 'creator';
      
      // 🔥 CRITICAL: Prevent welcome bonus claim and remove welcome bonus coins
      // Creators don't need coins to receive calls/texts, so they shouldn't get the welcome bonus
      // Set coins to 0 and mark welcome bonus as claimed so they can't claim it later
      const previousCoins = targetUser.coins || 0;
      targetUser.welcomeBonusClaimed = true; // Mark as claimed so they can't claim it later (even if demoted back to user)
      targetUser.coins = 0; // Set coins to 0 - creators don't need coins
      
      if (previousCoins > 0) {
        console.log(`💰 [USER] Removed ${previousCoins} coins from user ${targetUser._id} (promoted to creator, coins set to 0)`);
      }
      
      await targetUser.save({ session });

      // Create creator profile within transaction
      const creator = await Creator.create([{
        name,
        about,
        photo,
        userId: targetUser._id,
        categories: Array.isArray(categories) ? categories : [],
        price,
      }], { session });

      // Commit transaction
      await session.commitTransaction();
      
      const createdCreator = creator[0];
      
      // Log promotion event (structured for future audit log)
      console.log(`📝 [AUDIT] ADMIN_PROMOTED_USER`);
      console.log(`   Admin: ${adminUser._id} (${adminUser.email || adminUser.phone})`);
      console.log(`   User: ${targetUser._id} (${targetUser.email || targetUser.phone})`);
      console.log(`   Creator Profile: ${createdCreator._id}`);
      console.log(`   Timestamp: ${new Date().toISOString()}`);
      
      console.log(`✅ [USER] User ${targetUser._id} promoted to creator. Creator profile: ${createdCreator._id}`);

      // Invalidate admin caches after promotion
      invalidateAdminCaches('overview', 'creators_performance', 'users_analytics').catch(() => {});

      res.status(201).json({
        success: true,
        data: {
          user: {
            id: targetUser._id.toString(),
            email: targetUser.email,
            phone: targetUser.phone,
            role: targetUser.role,
          },
          creator: {
            id: createdCreator._id.toString(),
            userId: createdCreator.userId.toString(),
            name: createdCreator.name,
            about: createdCreator.about,
            photo: createdCreator.photo,
            categories: createdCreator.categories,
            price: createdCreator.price,
            createdAt: createdCreator.createdAt,
            updatedAt: createdCreator.updatedAt,
          },
        },
      });
    } catch (error) {
      // Rollback transaction on error
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }

  } catch (error) {
    console.error('❌ [USER] Promote to creator error:', error);
    if (error instanceof Error && error.name === 'ValidationError') {
      res.status(400).json({
        success: false,
        error: error.message,
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

export const updateProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    const { gender, username, avatar, categories } = req.body;

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });

    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found. Call POST /auth/login once to create the user.',
      });
      return;
    }

    let updated = false;

    // Update gender
    if (gender && !['male', 'female', 'other'].includes(gender)) {
      res.status(400).json({
        success: false,
        error: 'Invalid gender. Must be male, female, or other',
      });
      return;
    }
    if (gender) {
      user.gender = gender as 'male' | 'female' | 'other';
      updated = true;
    }

    // Update username
    if (username !== undefined) {
      if (username.length < 4 || username.length > 10) {
        res.status(400).json({
          success: false,
          error: 'Username must be between 4 and 10 characters',
        });
        return;
      }

      // Check if username changed
      if (user.username !== username) {
        user.username = username;
        user.usernameChangeCount = (user.usernameChangeCount || 0) + 1;
        updated = true;
        console.log(`✅ [USER] Username updated - Change count: ${user.usernameChangeCount}`);
      }
    }

    // Update avatar
    if (avatar !== undefined) {
      user.avatar = avatar;
      updated = true;
    }

    // Update categories
    if (categories !== undefined) {
      if (!Array.isArray(categories)) {
        res.status(400).json({
          success: false,
          error: 'Categories must be an array',
        });
        return;
      }
      if (categories.length > 4) {
        res.status(400).json({
          success: false,
          error: 'Maximum 4 categories allowed',
        });
        return;
      }
      user.categories = categories;
      updated = true;
    }

    if (updated) {
      await user.save();
      console.log(`✅ [USER] User profile updated`);
    }

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
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        },
      },
    });
  } catch (error) {
    console.error('Update profile error:', error);
    if (error instanceof Error && error.name === 'ValidationError') {
      res.status(400).json({
        success: false,
        error: error.message,
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// Claim welcome bonus (30 coins for new users only)
export const claimWelcomeBonus = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('🎁 [USER] Claim welcome bonus request');

    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    // Only regular users can claim (not creators/admins)
    if (user.role !== 'user') {
      res.status(403).json({ success: false, error: 'Only regular users can claim welcome bonus' });
      return;
    }

    // Check if already claimed
    if (user.welcomeBonusClaimed) {
      res.status(400).json({ success: false, error: 'Welcome bonus already claimed' });
      return;
    }

    const WELCOME_BONUS = 30;

    // Create transaction record
    const transaction = new CoinTransaction({
      transactionId: `welcome_bonus_${user._id}`,
      userId: user._id,
      type: 'credit',
      coins: WELCOME_BONUS,
      source: 'admin',
      description: 'Welcome bonus - 30 free coins',
      status: 'completed',
    });

    // Update user
    user.coins = (user.coins || 0) + WELCOME_BONUS;
    user.welcomeBonusClaimed = true;

    await transaction.save();
    await user.save();

    console.log(`✅ [USER] Welcome bonus claimed: ${user._id} now has ${user.coins} coins`);

    // Balance integrity check (fire-and-forget)
    verifyUserBalance(user._id).catch(() => {});

    // Emit coins_updated socket event so all open screens update in real-time
    try {
      const io = getIO();
      io.to(`user:${user.firebaseUid}`).emit('coins_updated', {
        userId: user._id.toString(),
        coins: user.coins,
      });
      console.log(`📡 [USER] Emitted coins_updated to ${user.firebaseUid} (${user.coins} coins)`);
    } catch (socketErr) {
      console.error('⚠️ [USER] Failed to emit coins_updated:', socketErr);
    }

    res.json({
      success: true,
      data: {
        coins: user.coins,
        bonusAmount: WELCOME_BONUS,
        welcomeBonusClaimed: true,
      },
    });
  } catch (error) {
    console.error('❌ [USER] Claim welcome bonus error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// Add coins to user account
export const addCoins = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('💰 [USER] Add coins request');
    
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    const { coins, transactionId } = req.body;

    if (!coins || typeof coins !== 'number' || coins <= 0) {
      res.status(400).json({
        success: false,
        error: 'Invalid coins amount. Must be a positive number',
      });
      return;
    }

    // Only allow regular users to add coins (not creators/admins)
    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    if (user.role === 'creator' || user.role === 'admin') {
      res.status(403).json({
        success: false,
        error: 'Creators and admins cannot add coins through this endpoint',
      });
      return;
    }

    // 🔒 IDEMPOTENCY: Generate or use provided transactionId
    const finalTransactionId = transactionId || `manual_${randomUUID()}`;

    // Check if this transaction already exists (idempotency check)
    const existingTransaction = await CoinTransaction.findOne({ transactionId: finalTransactionId });
    if (existingTransaction) {
      console.log(`⚠️  [USER] Duplicate transaction detected: ${finalTransactionId}`);
      
      // Return the existing transaction result (idempotent response)
      res.json({
        success: true,
        data: {
          transactionId: existingTransaction.transactionId,
          userId: user._id.toString(),
          coinsAdded: existingTransaction.coins,
          newCoinsBalance: user.coins,
          message: 'Transaction already processed (idempotent)',
        },
      });
      return;
    }

    // Create transaction record first (before updating user balance)
    const transaction = new CoinTransaction({
      transactionId: finalTransactionId,
      userId: user._id,
      type: 'credit',
      coins,
      source: 'manual',
      description: `Added ${coins} coins`,
      status: 'completed',
    });

    // Add coins to user account
    const oldCoins = user.coins;
    user.coins = (user.coins || 0) + coins;
    
    // Save both in a transaction (if MongoDB supports it) or sequentially
    await transaction.save();
    await user.save();

    console.log(`✅ [USER] Coins added: ${oldCoins} → ${user.coins} (+${coins})`);
    console.log(`   Transaction ID: ${finalTransactionId}`);

    // Balance integrity check (fire-and-forget)
    verifyUserBalance(user._id).catch(() => {});

    // Emit coins_updated socket event so all open screens update in real-time
    try {
      const io = getIO();
      io.to(`user:${user.firebaseUid}`).emit('coins_updated', {
        userId: user._id.toString(),
        coins: user.coins,
      });
      console.log(`📡 [USER] Emitted coins_updated to ${user.firebaseUid} (${user.coins} coins)`);
    } catch (socketErr) {
      // Non-fatal — the HTTP response still carries the new balance
      console.error('⚠️ [USER] Failed to emit coins_updated:', socketErr);
    }

    res.json({
      success: true,
      data: {
        transactionId: finalTransactionId,
        user: {
          id: user._id.toString(),
          coins: user.coins,
          coinsAdded: coins,
        },
      },
    });
  } catch (error) {
    console.error('❌ [USER] Add coins error:', error);
    
    // Handle duplicate key error (idempotency violation - race condition)
    if (error instanceof Error && (error.message.includes('duplicate key') || error.message.includes('E11000'))) {
      console.log(`⚠️  [USER] Duplicate transaction ID detected (race condition)`);
      const { transactionId } = req.body;
      if (transactionId) {
        try {
          const existingTransaction = await CoinTransaction.findOne({ transactionId });
          if (existingTransaction) {
            const user = await User.findById(existingTransaction.userId);
            res.json({
              success: true,
              data: {
                transactionId: existingTransaction.transactionId,
                userId: existingTransaction.userId.toString(),
                coinsAdded: existingTransaction.coins,
                newCoinsBalance: user?.coins || 0,
                message: 'Transaction already processed (idempotent)',
              },
            });
            return;
          }
        } catch (lookupError) {
          console.error('❌ [USER] Error looking up existing transaction:', lookupError);
        }
      }
    }
    
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

/**
 * Get user transaction history
 * 
 * 🚨 NAMING: Users use "coins", "balance", "credits", "debits"
 * ❌ NOT "earnings" or "totalEarned" (those are for creators)
 * 
 * 🔒 IMMUTABILITY: Transactions are append-only
 * - No updates except status (pending -> completed/failed)
 * - No deletes (ever)
 * - This ensures audit trail integrity for financial records
 */
export const getUserTransactions = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('📋 [USER] Get transactions request');
    
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    // Only regular users can view their transactions
    if (user.role === 'creator' || user.role === 'admin') {
      res.status(403).json({
        success: false,
        error: 'Creators should use /creator/transactions endpoint',
      });
      return;
    }

    // Get pagination params
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const skip = (page - 1) * limit;

    // Get transactions for this user (indexed by userId, createdAt)
    const transactions = await CoinTransaction.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip);

    const total = await CoinTransaction.countDocuments({ userId: user._id });

    // Calculate summary (users: credits/debits/balance)
    const credits = transactions.filter(t => t.type === 'credit').reduce((sum, t) => sum + t.coins, 0);
    const debits = transactions.filter(t => t.type === 'debit').reduce((sum, t) => sum + t.coins, 0);

    res.json({
      success: true,
      data: {
        transactions: transactions.map(tx => ({
          id: tx._id.toString(),
          transactionId: tx.transactionId,
          type: tx.type,
          coins: tx.coins, // Users: coins (credits/debits)
          source: tx.source,
          description: tx.description,
          callId: tx.callId,
          status: tx.status,
          createdAt: tx.createdAt.toISOString(),
        })),
        summary: {
          totalCredits: credits,
          totalDebits: debits,
          netChange: credits - debits,
          currentBalance: user.coins, // Users: balance
        },
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('❌ [USER] Get transactions error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// CALL HISTORY
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /user/call-history
 *
 * Returns the authenticated user's call history, sorted by most recent first.
 * Works for both regular users and creators (each sees their own records).
 *
 * Query params:
 *   page   (default 1)
 *   limit  (default 20, max 50)
 */
export const getCallHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('📋 [USER] Get call history request');

    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;

    const [calls, total] = await Promise.all([
      CallHistory.find({ ownerUserId: user._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CallHistory.countDocuments({ ownerUserId: user._id }),
    ]);

    res.json({
      success: true,
      data: {
        calls,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('❌ [USER] Get call history error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
