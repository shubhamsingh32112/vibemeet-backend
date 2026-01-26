import type { Request } from 'express';
import { Response } from 'express';
import mongoose from 'mongoose';
import { Creator } from './creator.model';
import { User } from '../user/user.model';

// Get all creators (for users to see - excludes other creators)
export const getAllCreators = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('📋 [CREATOR] Get all creators request');
    
    // Check if user is authenticated and get their role
    let currentUser = null;
    if (req.auth) {
      currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    }
    
    // Only users (not creators) can see creators
    // Admins can see creators when in "user view" mode
    // If user is a creator (but not admin), they should see users instead (via /user/list)
    if (currentUser && currentUser.role === 'creator') {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Creators cannot view other creators. Use /user/list to view users.',
      });
      return;
    }
    
    const creators = await Creator.find().sort({ createdAt: -1 });
    
    // Map creators with their associated user IDs (pure read - no side effects)
    const creatorsWithUserIds = creators.map((creator) => {
      return {
        id: creator._id.toString(),
        userId: creator.userId ? creator.userId.toString() : null, // User ID for initiating calls
        name: creator.name,
        about: creator.about,
        photo: creator.photo,
        categories: creator.categories,
        price: creator.price,
        createdAt: creator.createdAt,
        updatedAt: creator.updatedAt,
      };
    });
    
    res.json({
      success: true,
      data: {
        creators: creatorsWithUserIds,
      },
    });
  } catch (error) {
    console.error('❌ [CREATOR] Get all creators error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// Get single creator by ID
export const getCreatorById = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    console.log(`📋 [CREATOR] Get creator by ID: ${id}`);
    
    const creator = await Creator.findById(id);
    
    if (!creator) {
      res.status(404).json({
        success: false,
        error: 'Creator not found',
      });
      return;
    }
    
    // Pure read - no side effects, no auto-linking
    res.json({
      success: true,
      data: {
        creator: {
          id: creator._id.toString(),
          userId: creator.userId ? creator.userId.toString() : null, // User ID for initiating calls
          name: creator.name,
          about: creator.about,
          photo: creator.photo,
          categories: creator.categories,
          price: creator.price,
          createdAt: creator.createdAt,
          updatedAt: creator.updatedAt,
        },
      },
    });
  } catch (error) {
    console.error('❌ [CREATOR] Get creator by ID error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// Create new creator (Admin only) - Requires userId (user must exist first)
export const createCreator = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('➕ [CREATOR] Create creator request');
    
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
    
    const { name, about, photo, userId, categories, price } = req.body;
    
    // Validation
    if (!name || !about || !photo || !userId || price === undefined) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: name, about, photo, userId, price',
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
    
    // Verify user exists
    const targetUser = await User.findById(userId);
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
    
    // Check if creator with this userId already exists
    const existingCreator = await Creator.findOne({ userId: targetUser._id });
    if (existingCreator) {
      res.status(409).json({
        success: false,
        error: 'Creator profile already exists for this user',
      });
      return;
    }
    
    // Create creator profile
    const creator = await Creator.create({
      name,
      about,
      photo,
      userId: targetUser._id,
      categories: Array.isArray(categories) ? categories : [],
      price,
    });
    
    // Update user role to creator (if not already admin)
    if (targetUser.role !== 'creator' && targetUser.role !== 'admin') {
      targetUser.role = 'creator';
      await targetUser.save();
    }
    
    console.log(`✅ [CREATOR] Creator created: ${creator._id} for user: ${targetUser._id}`);
    
    res.status(201).json({
      success: true,
      data: {
        creator: {
          id: creator._id.toString(),
          userId: creator.userId.toString(),
          name: creator.name,
          about: creator.about,
          photo: creator.photo,
          categories: creator.categories,
          price: creator.price,
          createdAt: creator.createdAt,
          updatedAt: creator.updatedAt,
        },
      },
    });
  } catch (error) {
    console.error('❌ [CREATOR] Create creator error:', error);
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

// Update creator (Admin only) - Only updates creator profile, never touches user identity
export const updateCreator = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    console.log(`✏️ [CREATOR] Update creator: ${id}`);
    
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
    
    const { name, about, photo, categories, price } = req.body;
    
    const creator = await Creator.findById(id);
    if (!creator) {
      res.status(404).json({
        success: false,
        error: 'Creator not found',
      });
      return;
    }
    
    // Only update creator profile fields - never touch userId or user identity
    if (name) creator.name = name;
    if (about) creator.about = about;
    if (photo) creator.photo = photo;
    
    if (categories !== undefined) {
      if (!Array.isArray(categories) || categories.some((c) => typeof c !== 'string')) {
        res.status(400).json({
          success: false,
          error: 'Categories must be an array of strings',
        });
        return;
      }
      creator.categories = categories;
    }
    if (price !== undefined) creator.price = price;
    
    await creator.save();
    
    console.log(`✅ [CREATOR] Creator updated: ${creator._id}`);
    
    res.json({
      success: true,
      data: {
        creator: {
          id: creator._id.toString(),
          userId: creator.userId.toString(),
          name: creator.name,
          about: creator.about,
          photo: creator.photo,
          categories: creator.categories,
          price: creator.price,
          createdAt: creator.createdAt,
          updatedAt: creator.updatedAt,
        },
      },
    });
  } catch (error) {
    console.error('❌ [CREATOR] Update creator error:', error);
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

// Delete creator (Admin only)
// Business Rule: Deleting a creator profile ALWAYS downgrades the user role back to 'user'
// This ensures data consistency - if creator profile is gone, user should not have creator role
export const deleteCreator = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    console.log(`🗑️ [CREATOR] Delete creator: ${id}`);
    
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
    
    const creator = await Creator.findById(id);
    if (!creator) {
      res.status(404).json({
        success: false,
        error: 'Creator not found',
      });
      return;
    }
    
    const userId = creator.userId;
    
    // Atomic operation: Delete creator profile + Downgrade user role (using transaction)
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Delete creator profile within transaction
      await Creator.findByIdAndDelete(id, { session });
      
      // Business Rule: Always downgrade user role back to 'user' (unless they're admin)
      // This maintains consistency - no creator profile = no creator role
      if (userId) {
        const user = await User.findById(userId).session(session);
        if (user && user.role === 'creator') {
          user.role = 'user';
          await user.save({ session });
        }
      }
      
      // Commit transaction
      await session.commitTransaction();
      
      // Log demotion event (structured for future audit log)
      console.log(`📝 [AUDIT] ADMIN_DEMOTED_CREATOR`);
      console.log(`   Admin: ${adminUser._id} (${adminUser.email || adminUser.phone})`);
      console.log(`   Creator Profile: ${id}`);
      console.log(`   User: ${userId} (downgraded to 'user')`);
      console.log(`   Timestamp: ${new Date().toISOString()}`);
      
      console.log(`✅ [CREATOR] Creator deleted: ${id}`);
      if (userId) {
        console.log(`   ✅ User ${userId} downgraded to 'user' role`);
      }
      
      res.json({
        success: true,
        message: 'Creator deleted successfully. User role has been downgraded to "user".',
      });
    } catch (error) {
      // Rollback transaction on error
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  } catch (error) {
    console.error('❌ [CREATOR] Delete creator error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};
