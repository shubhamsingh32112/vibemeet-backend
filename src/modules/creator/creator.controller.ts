import type { Request } from 'express';
import { Response } from 'express';
import mongoose from 'mongoose';
import { Creator } from './creator.model';
import { User } from '../user/user.model';
import { Call } from '../call/call.model';
import { CreatorTaskProgress } from './creator-task.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { CREATOR_TASKS, getTaskByKey, isValidTaskKey } from './creator-tasks.config';
import { getIO } from '../../socket';
import { randomUUID } from 'crypto';

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
    
    // Admins see ALL creators (online and offline)
    // Regular users only see online creators on homepage (offline creators are hidden)
    const isAdmin = currentUser && currentUser.role === 'admin';
    const query = isAdmin ? {} : { isOnline: true };
    const creators = await Creator.find(query).sort({ createdAt: -1 });
    
    if (isAdmin) {
      console.log(`✅ [CREATOR] Admin request: Found ${creators.length} creator(s) (all creators, online and offline)`);
    } else {
      console.log(`✅ [CREATOR] Found ${creators.length} online creator(s) (offline creators are hidden)`);
    }

    // Favorites are a "user-only" feature
    const favoriteSet =
      currentUser && currentUser.role === 'user'
        ? new Set((currentUser.favoriteCreatorIds || []).map((id: any) => id.toString()))
        : new Set<string>();
    
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
        isOnline: creator.isOnline,
        isFavorite: favoriteSet.has(creator._id.toString()),
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
          isOnline: creator.isOnline,
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

// Set creator online status (Creator only - can set their own status)
export const setCreatorOnlineStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const { isOnline } = req.body;
    console.log(`🔄 [CREATOR] Set online status request: ${isOnline}`);
    
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }
    
    // Get current user
    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }
    
    // Only creators can set their online status
    if (currentUser.role !== 'creator' && currentUser.role !== 'admin') {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Only creators can set online status',
      });
      return;
    }
    
    // Find creator profile
    const creator = await Creator.findOne({ userId: currentUser._id });
    if (!creator) {
      res.status(404).json({
        success: false,
        error: 'Creator profile not found',
      });
      return;
    }
    
    // Validate isOnline parameter
    if (typeof isOnline !== 'boolean') {
      res.status(400).json({
        success: false,
        error: 'isOnline must be a boolean',
      });
      return;
    }
    
    // Update online status
    creator.isOnline = isOnline;
    await creator.save();
    
    console.log(`✅ [CREATOR] Creator ${creator._id} online status set to: ${isOnline}`);
    
    // Broadcast status change to all users via Socket.IO
    // This allows users' homepages to update in real-time
    try {
      const io = getIO();
      io.emit('creator_status_changed', {
        creatorId: creator._id.toString(),
        userId: creator.userId.toString(),
        isOnline: creator.isOnline,
        name: creator.name,
      });
      console.log(`📡 [SOCKET] Broadcasted creator_status_changed: ${creator._id} is now ${isOnline ? 'online' : 'offline'}`);
    } catch (socketError) {
      // Don't fail the request if socket emit fails
      console.error('⚠️  [SOCKET] Failed to broadcast creator status change:', socketError);
    }
    
    res.json({
      success: true,
      data: {
        creator: {
          id: creator._id.toString(),
          userId: creator.userId.toString(),
          name: creator.name,
          isOnline: creator.isOnline,
        },
      },
    });
  } catch (error) {
    console.error('❌ [CREATOR] Set online status error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// Get creator earnings from call history
export const getCreatorEarnings = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('💰 [CREATOR] Get earnings request');
    
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    // Get current user
    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    // Verify user is a creator
    if (currentUser.role !== 'creator' && currentUser.role !== 'admin') {
      res.status(403).json({
        success: false,
        error: 'Only creators can view earnings',
      });
      return;
    }

    // Find creator profile to get price
    const creator = await Creator.findOne({ userId: currentUser._id });
    if (!creator) {
      res.status(404).json({
        success: false,
        error: 'Creator profile not found',
      });
      return;
    }

    // Get all ended calls for this creator
    const endedCalls = await Call.find({
      creatorUserId: currentUser._id,
      status: 'ended',
      duration: { $gt: 0 }, // Only calls with duration > 0
      acceptedAt: { $exists: true }, // Only calls that were accepted
    })
      .populate('callerUserId', 'username')
      .sort({ endedAt: -1 }) // Most recent first
      .limit(100); // Limit to last 100 calls for performance

    console.log(`📊 [CREATOR] Found ${endedCalls.length} ended call(s) for earnings calculation`);

    // 🔒 CRITICAL: Use snapshot data from calls to prevent historical earnings changes
    // If price or revenue share changes, historical earnings remain accurate
    let totalEarnings = 0;
    let totalMinutes = 0;
    let callsWithSnapshots = 0;
    let callsWithoutSnapshots = 0;
    
    const callBreakdown = endedCalls.map((call) => {
      // Safely handle duration
      const durationSeconds = call.duration || 0;
      const durationMinutes = durationSeconds / 60; // Convert seconds to minutes
      
      // Use snapshot data if available (newer calls), otherwise fallback to calculation
      let callEarnings = 0;
      if (call.userPaidCoins != null && call.creatorShareAtCallTime != null) {
        // Use snapshot: creator earns their share of what user paid
        callEarnings = call.userPaidCoins * call.creatorShareAtCallTime;
        callsWithSnapshots++;
      } else {
        // Fallback for old calls without snapshots: calculate from snapshot price
        // This is a migration path - all new calls will have snapshots
        const pricePerMinute = call.priceAtCallTime || creator.price || 0;
        const sharePercentage = call.creatorShareAtCallTime || 0.30; // Default 30%
        // 🚨 CRITICAL: Use Math.ceil to match user deduction logic (consistent rounding)
        // User pays: Math.ceil(price * durationMinutes)
        // Creator earns: (what user paid) * sharePercentage
        const userPaidForCall = Math.ceil(pricePerMinute * durationMinutes);
        callEarnings = userPaidForCall * sharePercentage;
        callsWithoutSnapshots++;
        console.log(`⚠️  [CREATOR] Call ${call.callId} missing snapshot, using fallback calculation`);
      }
      
      totalEarnings += callEarnings;
      totalMinutes += durationMinutes;

      // Safely get caller username
      let callerUsername = 'Unknown';
      if (call.callerUserId && typeof call.callerUserId === 'object') {
        callerUsername = (call.callerUserId as any)?.username || 'Unknown';
      }

      return {
        callId: call.callId,
        callerUsername: callerUsername,
        duration: durationSeconds, // Duration in seconds
        durationFormatted: durationSeconds > 0 ? formatCallDuration(durationSeconds) : '0s',
        durationMinutes: Math.round(durationMinutes * 100) / 100, // Round to 2 decimals
        earnings: Math.round(callEarnings * 100) / 100, // Round to 2 decimals
        endedAt: call.endedAt?.toISOString() || null,
      };
    });

    // Round total earnings to 2 decimals
    totalEarnings = Math.round(totalEarnings * 100) / 100;
    
    // Calculate average earnings per minute from historical calls (for reference)
    const avgEarningsPerMinute = totalMinutes > 0 ? totalEarnings / totalMinutes : 0;
    
    // 🚨 FIX: Calculate CURRENT earnings per minute based on current price (not historical average)
    // This is what the creator will earn for NEW calls at their current price
    const CREATOR_SHARE_PERCENTAGE = 0.30; // 30% of what user pays
    const currentEarningsPerMinute = creator.price * CREATOR_SHARE_PERCENTAGE;

    console.log(`💰 [CREATOR] Total earnings: ${totalEarnings} coins from ${totalMinutes.toFixed(2)} minutes`);
    console.log(`   Calls with snapshots: ${callsWithSnapshots}, without: ${callsWithoutSnapshots}`);
    console.log(`   Current price: ${creator.price} coins/min → Current earnings: ${currentEarningsPerMinute.toFixed(2)} coins/min (30%)`);
    console.log(`   Historical average: ${avgEarningsPerMinute.toFixed(2)} coins/min`);

    res.json({
      success: true,
      data: {
        totalEarnings, // Total earnings (derived from historical calls with snapshots)
        totalMinutes: Math.round(totalMinutes * 100) / 100,
        totalCalls: endedCalls.length,
        avgEarningsPerMinute: Math.round(avgEarningsPerMinute * 100) / 100, // Historical average (for reference)
        earningsPerMinute: Math.round(currentEarningsPerMinute * 100) / 100, // CURRENT rate based on current price
        currentPrice: creator.price, // Creator's current price per minute (for percentage calculation)
        creatorSharePercentage: CREATOR_SHARE_PERCENTAGE, // Creator's share (0.30 = 30%)
        calls: callBreakdown,
        // Note: This is earnings, not withdrawable balance
        // pendingPayout and paidOut will be added when payout system is implemented
      },
    });
  } catch (error) {
    console.error('❌ [CREATOR] Get earnings error:', error);
    console.error('   Error details:', error instanceof Error ? error.stack : error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * Get creator transaction history (earnings from calls)
 * 
 * 🚨 NAMING: Creators use "earnings", "earnedAmount", "totalEarned"
 * ❌ NOT "coins", NOT "balance" (those are for users)
 * 
 * ⚠️ IMPORTANT: These are earnings records, NOT withdrawable balance
 * - No payout/withdrawal functionality yet
 * - Earnings are derived from call history
 * - Payout system will be implemented separately
 * 
 * 🔒 IMMUTABILITY: Call records are append-only
 * - Earnings calculated from immutable call snapshots
 * - Historical earnings never change (price snapshots prevent this)
 */
export const getCreatorTransactions = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('📋 [CREATOR] Get transactions request');
    
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    // Get current user
    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    // Verify user is a creator
    if (currentUser.role !== 'creator' && currentUser.role !== 'admin') {
      res.status(403).json({
        success: false,
        error: 'Only creators can view earnings transactions',
      });
      return;
    }

    // Find creator profile
    const creator = await Creator.findOne({ userId: currentUser._id });
    if (!creator) {
      res.status(404).json({
        success: false,
        error: 'Creator profile not found',
      });
      return;
    }

    // Get pagination params
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const skip = (page - 1) * limit;

    // Get all ended calls for this creator (these are the "transactions" - earnings)
    const endedCalls = await Call.find({
      creatorUserId: currentUser._id,
      status: 'ended',
      duration: { $gt: 0 },
      acceptedAt: { $exists: true },
      isSettled: true, // Only settled calls
    })
      .populate('callerUserId', 'username avatar')
      .sort({ endedAt: -1 })
      .limit(limit)
      .skip(skip);

    const total = await Call.countDocuments({
      creatorUserId: currentUser._id,
      status: 'ended',
      duration: { $gt: 0 },
      acceptedAt: { $exists: true },
      isSettled: true,
    });

    // Calculate earnings for each call
    const transactions = endedCalls.map((call) => {
      const durationSeconds = call.duration || 0;
      const durationMinutes = durationSeconds / 60;
      
      // Use snapshot data if available
      let earnings = 0;
      if (call.userPaidCoins != null && call.creatorShareAtCallTime != null) {
        earnings = call.userPaidCoins * call.creatorShareAtCallTime;
      } else {
        // Fallback for legacy calls
        const pricePerMinute = call.priceAtCallTime || creator.price || 0;
        const sharePercentage = call.creatorShareAtCallTime || 0.30;
        const userPaidForCall = Math.ceil(pricePerMinute * durationMinutes);
        earnings = userPaidForCall * sharePercentage;
      }

      const caller = call.callerUserId as any;
      return {
        id: call._id.toString(),
        transactionId: `call_${call.callId}`,
        type: 'credit', // Creators earn (credit)
        // 🚨 NAMING: Use "earnedAmount" not "coins" for creators
        earnedAmount: Math.round(earnings * 100) / 100,
        source: 'video_call',
        description: `Video call with ${caller?.username || 'user'}`,
        callId: call.callId,
        duration: durationSeconds,
        durationFormatted: durationSeconds > 0 ? formatCallDuration(durationSeconds) : '0s',
        callerUsername: caller?.username || 'Unknown',
        createdAt: call.endedAt?.toISOString() || call.createdAt.toISOString(),
      };
    });

    // Calculate total earnings
    // 🚨 NAMING: totalEarned (not totalCoins, not balance)
    const totalEarned = transactions.reduce((sum, tx) => sum + tx.earnedAmount, 0);

    res.json({
      success: true,
      data: {
        transactions,
        summary: {
          // 🚨 NAMING: totalEarned (NOT balance, NOT coins, NOT withdrawable)
          // This is earnings history, not available for withdrawal
          totalEarned: Math.round(totalEarned * 100) / 100,
          totalCalls: total,
        },
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
        // ⚠️ IMPORTANT: These are earnings records, not withdrawable balance
        // Payout system will be implemented separately
      },
    });
  } catch (error) {
    console.error('❌ [CREATOR] Get transactions error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// Helper function to format call duration
function formatCallDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (remainingSeconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Get creator tasks progress
 * 
 * Calculates total minutes from ended calls and returns task progress.
 * Only ended calls with duration > 0 count towards minutes.
 */
export const getCreatorTasks = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('📋 [CREATOR] Get tasks request');
    
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    // Get current user
    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    // Verify user is a creator
    if (currentUser.role !== 'creator' && currentUser.role !== 'admin') {
      res.status(403).json({
        success: false,
        error: 'Only creators can view tasks',
      });
      return;
    }

    // Calculate total minutes from ended calls
    // Reuse same logic as getCreatorEarnings
    const endedCalls = await Call.find({
      creatorUserId: currentUser._id,
      status: 'ended',
      duration: { $gt: 0 }, // Only calls with duration > 0
      acceptedAt: { $exists: true }, // Only calls that were accepted
    });

    // Sum duration in minutes
    let totalMinutes = 0;
    for (const call of endedCalls) {
      const durationSeconds = call.duration || 0;
      const durationMinutes = durationSeconds / 60;
      totalMinutes += durationMinutes;
    }

    console.log(`📊 [CREATOR] Total minutes: ${totalMinutes.toFixed(2)}`);

    // Get existing task progress records
    const taskProgressRecords = await CreatorTaskProgress.find({
      creatorUserId: currentUser._id,
    });

    // Create a map of taskKey -> progress record
    const progressMap = new Map<string, CreatorTaskProgress>();
    for (const record of taskProgressRecords) {
      progressMap.set(record.taskKey, record);
    }

    // Build tasks array with progress
    const tasks = CREATOR_TASKS.map((taskDef) => {
      const progress = progressMap.get(taskDef.key);
      const isCompleted = totalMinutes >= taskDef.thresholdMinutes;
      const isClaimed = progress?.claimedAt != null;
      
      // progressMinutes = min(totalMinutes, thresholdMinutes)
      const progressMinutes = Math.min(totalMinutes, taskDef.thresholdMinutes);

      return {
        taskKey: taskDef.key,
        thresholdMinutes: taskDef.thresholdMinutes,
        rewardCoins: taskDef.rewardCoins,
        progressMinutes: Math.round(progressMinutes * 100) / 100, // Round to 2 decimals
        isCompleted,
        isClaimed,
      };
    });

    res.json({
      success: true,
      data: {
        totalMinutes: Math.round(totalMinutes * 100) / 100, // Round to 2 decimals
        tasks,
      },
    });
  } catch (error) {
    console.error('❌ [CREATOR] Get tasks error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

/**
 * Claim task reward
 * 
 * Validates task completion, creates coin transaction, and credits coins.
 * Idempotent - safe to retry.
 */
export const claimTaskReward = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('🎁 [CREATOR] Claim task reward request');
    
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    const { taskKey } = req.params;

    // Validate task key exists
    if (!isValidTaskKey(taskKey)) {
      res.status(400).json({
        success: false,
        error: 'Invalid task key',
      });
      return;
    }

    const taskDef = getTaskByKey(taskKey);
    if (!taskDef) {
      res.status(404).json({
        success: false,
        error: 'Task not found',
      });
      return;
    }

    // Get current user
    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    // Verify user is a creator
    if (currentUser.role !== 'creator' && currentUser.role !== 'admin') {
      res.status(403).json({
        success: false,
        error: 'Only creators can claim task rewards',
      });
      return;
    }

    // Calculate total minutes (same logic as getCreatorTasks)
    const endedCalls = await Call.find({
      creatorUserId: currentUser._id,
      status: 'ended',
      duration: { $gt: 0 },
      acceptedAt: { $exists: true },
    });

    let totalMinutes = 0;
    for (const call of endedCalls) {
      const durationSeconds = call.duration || 0;
      const durationMinutes = durationSeconds / 60;
      totalMinutes += durationMinutes;
    }

    // Check if task is completed
    if (totalMinutes < taskDef.thresholdMinutes) {
      res.status(400).json({
        success: false,
        error: `Task not completed. Current: ${Math.round(totalMinutes)} minutes, Required: ${taskDef.thresholdMinutes} minutes`,
      });
      return;
    }

    // 🔒 PHASE T1: Atomic claim with race safety
    // Use findOneAndUpdate with condition to prevent double claims
    // This prevents: double taps, retry storms, two devices claiming simultaneously
    const now = new Date();
    const taskProgress = await CreatorTaskProgress.findOneAndUpdate(
      {
        creatorUserId: currentUser._id,
        taskKey,
        claimedAt: { $exists: false }, // Only update if not already claimed
      },
      {
        $set: {
          completedAt: now,
          claimedAt: now,
        },
        $setOnInsert: {
          // Only set these on insert (when creating new record)
          creatorUserId: currentUser._id,
          taskKey,
          thresholdMinutes: taskDef.thresholdMinutes,
          rewardCoins: taskDef.rewardCoins,
        },
      },
      {
        upsert: true, // Create if doesn't exist
        new: true, // Return updated document
      }
    );

    // If taskProgress is null, it means the condition didn't match (already claimed)
    // Check if it was already claimed by querying the existing record
    if (!taskProgress) {
      const existingProgress = await CreatorTaskProgress.findOne({
        creatorUserId: currentUser._id,
        taskKey,
      });
      
      if (existingProgress?.claimedAt) {
        console.log(`⚠️  [CREATOR] Task ${taskKey} already claimed (race condition prevented)`);
        res.status(409).json({
          success: false,
          error: 'Task reward already claimed',
          data: {
            taskKey,
            rewardCoins: taskDef.rewardCoins,
            coinsAdded: 0,
            newCoinsBalance: currentUser.coins,
            message: 'Task reward already claimed (idempotent)',
          },
        });
        return;
      }
      // If no existing progress found, something went wrong - continue anyway
      console.log(`⚠️  [CREATOR] Task progress not found after update attempt`);
    }

    // Generate transaction ID for idempotency (include timestamp for uniqueness)
    const transactionId = `creator_task_${taskKey}_${currentUser._id}_${Date.now()}`;

    // Check if transaction already exists (idempotency)
    const existingTransaction = await CoinTransaction.findOne({ transactionId });
    if (existingTransaction) {
      console.log(`⚠️  [CREATOR] Duplicate transaction detected: ${transactionId}`);
      res.json({
        success: true,
        data: {
          taskKey,
          rewardCoins: taskDef.rewardCoins,
          coinsAdded: existingTransaction.coins,
          newCoinsBalance: currentUser.coins,
          message: 'Transaction already processed (idempotent)',
        },
      });
      return;
    }

    // Create transaction record (before updating balance)
    const transaction = new CoinTransaction({
      transactionId,
      userId: currentUser._id,
      type: 'credit',
      coins: taskDef.rewardCoins,
      source: 'creator_task',
      description: `Bonus for completing ${taskDef.thresholdMinutes} mins`,
      status: 'completed',
    });

    // Add coins to user account
    const oldCoins = currentUser.coins || 0;
    currentUser.coins = oldCoins + taskDef.rewardCoins;

    // Save transaction and user (task progress already saved by findOneAndUpdate)
    await transaction.save();
    await currentUser.save();

    console.log(`✅ [CREATOR] Task reward claimed: ${taskKey}`);
    console.log(`   Coins: ${oldCoins} → ${currentUser.coins} (+${taskDef.rewardCoins})`);

    // 📊 A) Server-side logging for claims (audit trail for disputes)
    console.log(JSON.stringify({
      event: 'creator_task_claimed',
      timestamp: new Date().toISOString(),
      creatorUserId: currentUser._id.toString(),
      taskKey,
      rewardCoins: taskDef.rewardCoins,
      thresholdMinutes: taskDef.thresholdMinutes,
      totalMinutes: Math.round(totalMinutes * 100) / 100,
      transactionId,
      coinsBefore: oldCoins,
      coinsAfter: currentUser.coins,
    }));

    // Emit coins_updated socket event (same pattern as addCoins)
    try {
      const io = getIO();
      io.to(currentUser.firebaseUid).emit('coins_updated', {
        userId: currentUser._id.toString(),
        coins: currentUser.coins,
      });
      console.log(`📡 [SOCKET] Emitted coins_updated to creator: ${currentUser.firebaseUid}`);
    } catch (socketError) {
      console.error('⚠️  [SOCKET] Failed to emit coins_updated:', socketError);
    }

    res.json({
      success: true,
      data: {
        taskKey,
        rewardCoins: taskDef.rewardCoins,
        coinsAdded: taskDef.rewardCoins,
        newCoinsBalance: currentUser.coins,
      },
    });
  } catch (error) {
    console.error('❌ [CREATOR] Claim task reward error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};
