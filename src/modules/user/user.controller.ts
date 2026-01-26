import type { Request } from 'express';
import { Response } from 'express';
import mongoose from 'mongoose';
import { User } from './user.model';
import { Creator } from '../creator/creator.model';

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
      .select('username avatar gender categories createdAt')
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
      
      if (user.usernameChangeCount >= 3) {
        res.status(400).json({
          success: false,
          error: 'Username can only be changed 3 times',
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
      if (categories.length < 1 || categories.length > 4) {
        res.status(400).json({
          success: false,
          error: 'Must select between 1 and 4 categories',
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
