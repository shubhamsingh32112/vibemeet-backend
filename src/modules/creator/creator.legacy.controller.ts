import type { Request } from 'express';
import { Response } from 'express';
import mongoose from 'mongoose';
import {
  creatorListResponseDtoSchema,
  creatorProfileResponseDtoSchema,
  CreatorListResponseDto,
  CreatorProfileResponseDto,
} from '../../contracts/canonical.dto';
import { sendCompatibleResponse } from '../../contracts/compatibility';
import { Creator } from './creator.model';
import { User } from '../user/user.model';
import { CreatorTaskProgress, ICreatorTaskProgress } from './creator-task.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { CallHistory } from '../billing/call-history.model';
import { CREATOR_TASKS, getTaskByKey, isValidTaskKey, getDailyPeriodBounds } from './creator-tasks.config';
import { getIO } from '../../config/socket';
import { setCreatorAvailability } from '../availability/availability.gateway';
import { getBatchAvailability } from '../availability/availability.service';
import {
  getRedis,
  creatorDashboardKey,
  CREATOR_DASHBOARD_TTL,
  invalidateCreatorDashboard,
  invalidateAdminCaches,
} from '../../config/redis';
import { verifyUserBalance } from '../../utils/balance-integrity';
import { Withdrawal } from './withdrawal.model';
import { emitToAdmin } from '../admin/admin.gateway';

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
    
    // Return ALL creators regardless of online status.
    // Availability (online/busy) is managed via Redis + Socket.IO in real-time.
    // The REST endpoint always returns every creator; the frontend shows
    // online/busy tags based on the Socket.IO availability provider.
    const creators = await Creator.find({}).sort({ createdAt: -1 });
    
    console.log(`✅ [CREATOR] Found ${creators.length} creator(s) (all creators returned, availability via Redis)`);

    // Favorites are a "user-only" feature
    const favoriteSet =
      currentUser && currentUser.role === 'user'
        ? new Set((currentUser.favoriteCreatorIds || []).map((id: any) => id.toString()))
        : new Set<string>();
    
    // Map creators with their associated user IDs and Firebase UIDs (pure read - no side effects)
    // Need to get Firebase UIDs for Stream Video calls (Stream uses Firebase UIDs as user IDs)
    const creatorsWithUserIds = await Promise.all(
      creators.map(async (creator) => {
        let creatorFirebaseUid: string | null = null;
        if (creator.userId) {
          const creatorUser = await User.findById(creator.userId);
          creatorFirebaseUid = creatorUser?.firebaseUid || null;
        }
        
        return {
          id: creator._id.toString(),
          userId: creator.userId ? creator.userId.toString() : null, // MongoDB User ID
          firebaseUid: creatorFirebaseUid, // Firebase UID for Stream Video calls
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
      })
    );
    
    // 🔥 FIX: Batch-query Redis for real-time availability
    // This is the AUTHORITATIVE source — not MongoDB isOnline
    // Missing/expired Redis keys → 'busy' (safe default)
    const firebaseUids = creatorsWithUserIds
      .map(c => c.firebaseUid)
      .filter((uid): uid is string => uid !== null);
    
    const availabilityMap = firebaseUids.length > 0
      ? await getBatchAvailability(firebaseUids)
      : {};
    
    // Enrich each creator with their Redis availability
    const creatorsWithAvailability = creatorsWithUserIds.map(creator => ({
      ...creator,
      availability: creator.firebaseUid
        ? (availabilityMap[creator.firebaseUid] ?? 'busy')
        : 'busy',
    }));
    
    console.log(`📤 [CREATOR] Sending ${creatorsWithAvailability.length} creator(s) with availability`);
    
    const legacyData = {
      creators: creatorsWithAvailability,
    };
    const normalizedData: CreatorListResponseDto = {
      creators: creatorsWithAvailability.map((creator) => ({
        id: creator.id,
        userId: creator.userId,
        firebaseUid: creator.firebaseUid,
        name: creator.name,
        about: creator.about,
        photo: creator.photo,
        categories: creator.categories ?? [],
        price: creator.price,
        isOnline: creator.isOnline,
        availability: creator.availability === 'online' ? 'online' : 'busy',
        isFavorite: creator.isFavorite,
        createdAt: creator.createdAt?.toISOString(),
        updatedAt: creator.updatedAt?.toISOString(),
      })),
    };
    sendCompatibleResponse({
      req,
      res,
      legacyData,
      normalizedData,
      validator: creatorListResponseDtoSchema,
      deprecations: ['Legacy creator list under `data.creators` remains; normalized list available in `normalized.creators`.'],
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
    const legacyData = {
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
    };
    const normalizedData: CreatorProfileResponseDto = {
      creator: {
        id: creator._id.toString(),
        userId: creator.userId ? creator.userId.toString() : null,
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
      validator: creatorProfileResponseDtoSchema,
      deprecations: ['Legacy creator profile under `data.creator` remains; normalized profile is `normalized.creator`.'],
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

      // Invalidate admin caches after creator deletion
      invalidateAdminCaches('overview', 'creators_performance', 'users_analytics').catch(() => {});
      
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
    
    // Update MongoDB for legacy support (optional - not used for presence)
    creator.isOnline = isOnline;
    await creator.save();
    
    console.log(`✅ [CREATOR] Creator ${creator._id} availability set to: ${isOnline}`);
    
    // Update Redis + broadcast via Socket.IO for instant real-time availability
    try {
      const io = getIO();
      await setCreatorAvailability(
        io,
        currentUser.firebaseUid,
        isOnline ? 'online' : 'busy'
      );
      console.log(
        `📡 [REDIS+SOCKET] Creator availability updated: ${currentUser.firebaseUid} -> ${isOnline ? 'online' : 'busy'}`
      );
    } catch (availabilityError) {
      // Don't fail the request if Redis/Socket broadcast fails
      console.error('⚠️  [REDIS+SOCKET] Failed to update availability:', availabilityError);
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

    // Query actual earnings from CallHistory where this creator was the owner
    const callRecords = await CallHistory.find({
      ownerUserId: currentUser._id,
      ownerRole: 'creator',
      durationSeconds: { $gt: 0 },
    }).sort({ createdAt: -1 });

    const totalEarnings = callRecords.reduce((sum, call) => sum + (call.coinsEarned || 0), 0);
    const totalSeconds = callRecords.reduce((sum, call) => sum + call.durationSeconds, 0);
    const totalMinutes = totalSeconds / 60;
    const totalCalls = callRecords.length;
    const avgEarningsPerMinute = totalMinutes > 0 ? totalEarnings / totalMinutes : 0;
    // Current rate: creator earns 0.30 coins/sec = 18 coins/min
    const earningsPerMinute = 0.30 * 60; // 18 coins/min

    // Format call records for response
    const calls = callRecords.slice(0, 50).map((call) => {
      const mins = call.durationSeconds / 60;
      const formatted = call.durationSeconds >= 60
        ? `${Math.floor(call.durationSeconds / 60)}m ${call.durationSeconds % 60}s`
        : `${call.durationSeconds}s`;
      return {
        callId: call.callId,
        callerUsername: call.otherName || 'User',
        duration: call.durationSeconds,
        durationFormatted: formatted,
        durationMinutes: Math.round(mins * 100) / 100,
        earnings: call.coinsEarned,
        endedAt: call.createdAt.toISOString(),
      };
    });

    console.log(`✅ [CREATOR] Earnings: ${totalEarnings} coins from ${totalCalls} calls (${totalMinutes.toFixed(1)} mins)`);

    res.json({
      success: true,
      data: {
        totalEarnings,
        totalMinutes: Math.round(totalMinutes * 100) / 100,
        totalCalls,
        avgEarningsPerMinute: Math.round(avgEarningsPerMinute * 100) / 100,
        earningsPerMinute,
        currentPrice: creator.price,
        creatorSharePercentage: 0.30,
        calls,
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

    // Query actual transactions from CoinTransaction where this creator is the user
    const transactions = await CoinTransaction.find({ userId: currentUser._id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip);

    const total = await CoinTransaction.countDocuments({ userId: currentUser._id });

    // Calculate total earned from credit transactions
    const totalEarnedResult = await CoinTransaction.aggregate([
      { $match: { userId: currentUser._id, type: 'credit', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$coins' } } },
    ]);
    const totalEarned = totalEarnedResult.length > 0 ? totalEarnedResult[0].total : 0;

    res.json({
      success: true,
      data: {
        transactions: transactions.map(tx => ({
          id: tx._id.toString(),
          transactionId: tx.transactionId,
          type: tx.type,
          coins: tx.coins,
          source: tx.source,
          description: tx.description,
          callId: tx.callId,
          status: tx.status,
          createdAt: tx.createdAt.toISOString(),
        })),
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

    // ── Daily period bounds ─────────────────────────────────────────────
    const { periodStart, periodEnd, resetsAt } = getDailyPeriodBounds();

    // Compute total minutes from call history **within the current daily period**
    const callAgg = await CallHistory.aggregate([
      {
        $match: {
          ownerUserId: currentUser._id,
          ownerRole: 'creator',
          durationSeconds: { $gt: 0 },
          createdAt: { $gte: periodStart, $lt: periodEnd },
        },
      },
      {
        $group: {
          _id: null,
          totalSeconds: { $sum: '$durationSeconds' },
        },
      },
    ]);
    const totalMinutes = callAgg.length > 0 ? callAgg[0].totalSeconds / 60 : 0;

    // Get existing task progress records **for the current period only**
    const taskProgressRecords = await CreatorTaskProgress.find({
      creatorUserId: currentUser._id,
      periodStart,
    });

    // Create a map of taskKey -> progress record
    const progressMap = new Map<string, ICreatorTaskProgress>();
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
        resetsAt: resetsAt.toISOString(),
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

    // ── Daily period bounds ─────────────────────────────────────────────
    const { periodStart, periodEnd } = getDailyPeriodBounds();

    // Compute total minutes from call history **within the current daily period**
    const claimCallAgg = await CallHistory.aggregate([
      {
        $match: {
          ownerUserId: currentUser._id,
          ownerRole: 'creator',
          durationSeconds: { $gt: 0 },
          createdAt: { $gte: periodStart, $lt: periodEnd },
        },
      },
      {
        $group: {
          _id: null,
          totalSeconds: { $sum: '$durationSeconds' },
        },
      },
    ]);
    const totalMinutes = claimCallAgg.length > 0 ? claimCallAgg[0].totalSeconds / 60 : 0;

    // Check if task is completed (within today's period)
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
    // **periodStart** is included to scope claims to the current daily period.
    const now = new Date();
    const taskProgress = await CreatorTaskProgress.findOneAndUpdate(
      {
        creatorUserId: currentUser._id,
        taskKey,
        periodStart,
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
          periodStart,
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
        periodStart,
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


    // Balance integrity check (fire-and-forget)
    verifyUserBalance(currentUser._id).catch(() => {});

    // Invalidate dashboard cache so next fetch gets fresh data
    await invalidateCreatorDashboard(currentUser._id.toString());

    // Emit real-time update to the creator via Socket.IO
    try {
      emitCreatorDataUpdated(currentUser.firebaseUid, {
        reason: 'task_claimed',
        taskKey,
        newCoinsBalance: currentUser.coins,
      });
    } catch (emitErr) {
      console.error('⚠️ [CREATOR] Failed to emit data_updated:', emitErr);
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

// ══════════════════════════════════════════════════════════════════════════
// CREATOR DASHBOARD — Single endpoint returning all creator data (cached)
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /creator/dashboard
 *
 * Returns a consolidated view of the creator's data:
 * - Earnings summary (total, per-minute, call count)
 * - Task progress (all tasks with completion/claim status)
 * - Current coins balance
 * - Creator profile info (price, online status)
 *
 * 🔥 CACHED in Redis for 60 seconds. Invalidated after:
 * - Billing settlement (call ends)
 * - Task reward claim
 */
export const getCreatorDashboard = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('📊 [CREATOR] Dashboard request');

    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    if (currentUser.role !== 'creator' && currentUser.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Only creators can access dashboard' });
      return;
    }

    const creator = await Creator.findOne({ userId: currentUser._id });
    if (!creator) {
      res.status(404).json({ success: false, error: 'Creator profile not found' });
      return;
    }

    // ── Try Redis cache first ────────────────────────────────────────────
    const cacheKey = creatorDashboardKey(currentUser._id.toString());
    try {
      const redis = getRedis();
      const cached = await redis.get<string>(cacheKey);
      if (cached) {
        const data = typeof cached === 'string' ? JSON.parse(cached) : cached;
        // Update coins in cached data (coins can change outside of cache invalidation)
        data.coins = currentUser.coins;
        console.log('⚡ [CREATOR] Dashboard served from Redis cache');
        res.json({ success: true, data });
        return;
      }
    } catch (cacheErr) {
      console.error('⚠️ [CREATOR] Redis cache read failed:', cacheErr);
    }

    // ── Build dashboard data from DB ─────────────────────────────────────

    // ── Daily period bounds (for task progress) ───────────────────────
    const { periodStart, periodEnd, resetsAt } = getDailyPeriodBounds();

    // 1. Earnings from call history (all-time for earnings summary)
    const callRecords = await CallHistory.find({
      ownerUserId: currentUser._id,
      ownerRole: 'creator',
      durationSeconds: { $gt: 0 },
    }).sort({ createdAt: -1 });

    const totalEarnings = callRecords.reduce((sum, c) => sum + (c.coinsEarned || 0), 0);
    const totalSeconds = callRecords.reduce((sum, c) => sum + c.durationSeconds, 0);
    const allTimeMinutes = totalSeconds / 60;
    const totalCalls = callRecords.length;
    const earningsPerMinute = 0.30 * 60; // 18 coins/min (0.30/sec)
    const avgEarningsPerMinute = allTimeMinutes > 0 ? totalEarnings / allTimeMinutes : 0;

    const recentCalls = callRecords.slice(0, 20).map((call) => {
      const formatted = call.durationSeconds >= 60
        ? `${Math.floor(call.durationSeconds / 60)}m ${call.durationSeconds % 60}s`
        : `${call.durationSeconds}s`;
      return {
        callId: call.callId,
        callerUsername: call.otherName || 'User',
        duration: call.durationSeconds,
        durationFormatted: formatted,
        durationMinutes: Math.round((call.durationSeconds / 60) * 100) / 100,
        earnings: call.coinsEarned,
        endedAt: call.createdAt.toISOString(),
      };
    });

    // 2. Today's earnings + task progress — only count calls from the **current daily period**
    const todayCallAgg = await CallHistory.aggregate([
      {
        $match: {
          ownerUserId: currentUser._id,
          ownerRole: 'creator',
          durationSeconds: { $gt: 0 },
          createdAt: { $gte: periodStart, $lt: periodEnd },
        },
      },
      {
        $group: {
          _id: null,
          totalSeconds: { $sum: '$durationSeconds' },
          totalEarned: { $sum: '$coinsEarned' },
          callCount: { $sum: 1 },
        },
      },
    ]);
    const todayMinutes = todayCallAgg.length > 0 ? todayCallAgg[0].totalSeconds / 60 : 0;
    const todayEarnings = todayCallAgg.length > 0 ? todayCallAgg[0].totalEarned : 0;
    const todayCalls = todayCallAgg.length > 0 ? todayCallAgg[0].callCount : 0;

    const taskProgressRecords = await CreatorTaskProgress.find({
      creatorUserId: currentUser._id,
      periodStart,
    });
    const progressMap = new Map<string, ICreatorTaskProgress>();
    for (const record of taskProgressRecords) {
      progressMap.set(record.taskKey, record);
    }

    const tasks = CREATOR_TASKS.map((taskDef) => {
      const progress = progressMap.get(taskDef.key);
      const isCompleted = todayMinutes >= taskDef.thresholdMinutes;
      const isClaimed = progress?.claimedAt != null;
      const progressMinutes = Math.min(todayMinutes, taskDef.thresholdMinutes);
      return {
        taskKey: taskDef.key,
        thresholdMinutes: taskDef.thresholdMinutes,
        rewardCoins: taskDef.rewardCoins,
        progressMinutes: Math.round(progressMinutes * 100) / 100,
        isCompleted,
        isClaimed,
      };
    });

    // 3. Compose response
    const dashboardData = {
      // Earnings (all-time)
      earnings: {
        totalEarnings,
        totalMinutes: Math.round(allTimeMinutes * 100) / 100,
        totalCalls,
        avgEarningsPerMinute: Math.round(avgEarningsPerMinute * 100) / 100,
        earningsPerMinute,
        currentPrice: creator.price,
        creatorSharePercentage: 0.30,
        calls: recentCalls,
      },
      // Today's earnings (current daily period)
      todayEarnings: {
        totalEarnings: todayEarnings,
        totalMinutes: Math.round(todayMinutes * 100) / 100,
        totalCalls: todayCalls,
      },
      // Tasks (daily period)
      tasks: {
        totalMinutes: Math.round(todayMinutes * 100) / 100,
        items: tasks,
        resetsAt: resetsAt.toISOString(),
      },
      // Account
      coins: currentUser.coins,
      creatorProfile: {
        id: creator._id.toString(),
        name: creator.name,
        price: creator.price,
        isOnline: creator.isOnline,
      },
    };

    // ── Cache in Redis ───────────────────────────────────────────────────
    try {
      const redis = getRedis();
      await redis.setex(cacheKey, CREATOR_DASHBOARD_TTL, JSON.stringify(dashboardData));
      console.log('💾 [CREATOR] Dashboard cached in Redis');
    } catch (cacheErr) {
      console.error('⚠️ [CREATOR] Redis cache write failed:', cacheErr);
    }

    console.log(`✅ [CREATOR] Dashboard: ${totalEarnings} earnings, ${totalCalls} calls, ${tasks.length} tasks, ${currentUser.coins} coins`);

    res.json({ success: true, data: dashboardData });
  } catch (error) {
    console.error('❌ [CREATOR] Dashboard error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// WITHDRAWAL — Creator requests a withdrawal
// ══════════════════════════════════════════════════════════════════════════

/**
 * POST /creator/withdraw
 *
 * Creator requests to withdraw coins.
 * Rules:
 *   - Must be a creator
 *   - Minimum withdrawal: 100 coins
 *   - Amount must not exceed current balance
 *   - Coins are NOT deducted at this point (only on admin approval)
 *   - Creates a Withdrawal record with status 'pending'
 */
export const requestWithdrawal = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('💸 [CREATOR] Withdrawal request');

    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    if (currentUser.role !== 'creator' && currentUser.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Only creators can request withdrawals' });
      return;
    }

    const { amount, name, number, upi, accountNumber, ifsc } = req.body;

    if (typeof amount !== 'number' || amount <= 0) {
      res.status(400).json({ success: false, error: 'Amount must be a positive number' });
      return;
    }

    // Validate required withdrawal details
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ success: false, error: 'Name is required' });
      return;
    }

    if (!number || typeof number !== 'string' || number.trim().length === 0) {
      res.status(400).json({ success: false, error: 'Phone number is required' });
      return;
    }

    // At least one payment method must be provided (UPI or Bank Account)
    if ((!upi || upi.trim().length === 0) && 
        ((!accountNumber || accountNumber.trim().length === 0) || 
         (!ifsc || ifsc.trim().length === 0))) {
      res.status(400).json({ 
        success: false, 
        error: 'Either UPI ID or both Account Number and IFSC are required' 
      });
      return;
    }

    // If bank account is provided, both account number and IFSC are required
    if (accountNumber && accountNumber.trim().length > 0) {
      if (!ifsc || ifsc.trim().length === 0) {
        res.status(400).json({ success: false, error: 'IFSC code is required when account number is provided' });
        return;
      }
    }

    if (amount < 100) {
      res.status(400).json({ success: false, error: 'Minimum withdrawal amount is 100 coins' });
      return;
    }

    if (amount > currentUser.coins) {
      res.status(400).json({
        success: false,
        error: `Insufficient balance. You have ${currentUser.coins} coins but requested ${amount}`,
      });
      return;
    }

    // Optimized: Single query to check both pending withdrawal and cooldown
    // This reduces database round trips from 2 to 1, improving performance under load
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const existingWithdrawal = await Withdrawal.findOne({
      creatorUserId: currentUser._id,
      $or: [
        { status: 'pending' }, // Check for pending withdrawal
        { requestedAt: { $gte: oneDayAgo } }, // Check for recent withdrawal (cooldown)
      ],
    })
      .sort({ requestedAt: -1 }) // Get most recent first
      .limit(1)
      .lean(); // Use lean() for better performance (returns plain JS object)

    if (existingWithdrawal) {
      if (existingWithdrawal.status === 'pending') {
        res.status(409).json({
          success: false,
          error: 'You already have a pending withdrawal request. Please wait for it to be processed.',
        });
        return;
      }
      // Check if it's within cooldown period
      if (existingWithdrawal.requestedAt >= oneDayAgo) {
        res.status(429).json({
          success: false,
          error: 'You can only request one withdrawal per 24 hours. Please try again later.',
        });
        return;
      }
    }

    // Create withdrawal record — coins NOT deducted yet
    const withdrawal = await Withdrawal.create({
      creatorUserId: currentUser._id,
      amount,
      status: 'pending',
      requestedAt: new Date(),
      name: name.trim(),
      number: number.trim(),
      upi: upi?.trim() || undefined,
      accountNumber: accountNumber?.trim() || undefined,
      ifsc: ifsc?.trim() || undefined,
    });

    console.log(`✅ [CREATOR] Withdrawal requested: ${withdrawal._id} for ${amount} coins by user ${currentUser._id}`);

    // Emit to admin dashboard
    emitToAdmin('withdrawal:requested', {
      withdrawalId: withdrawal._id.toString(),
      creatorUserId: currentUser._id.toString(),
      amount,
    });

    res.status(201).json({
      success: true,
      data: {
        withdrawalId: withdrawal._id.toString(),
        amount: withdrawal.amount,
        status: withdrawal.status,
        requestedAt: withdrawal.requestedAt.toISOString(),
        message: 'Withdrawal request submitted. Coins will be deducted upon admin approval.',
      },
    });
  } catch (error) {
    console.error('❌ [CREATOR] Withdrawal request error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/**
 * GET /creator/withdrawals
 *
 * Get the current creator's withdrawal history.
 */
export const getMyWithdrawals = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    if (currentUser.role !== 'creator' && currentUser.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Only creators can view withdrawals' });
      return;
    }

    const withdrawals = await Withdrawal.find({ creatorUserId: currentUser._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    res.json({
      success: true,
      data: {
        withdrawals: withdrawals.map((w) => ({
          id: w._id.toString(),
          amount: w.amount,
          status: w.status,
          requestedAt: w.requestedAt,
          processedAt: w.processedAt || null,
          notes: w.notes || null,
          name: (w as any).name || null,
          number: (w as any).number || null,
          upi: (w as any).upi || null,
          accountNumber: (w as any).accountNumber || null,
          ifsc: (w as any).ifsc || null,
          createdAt: w.createdAt,
        })),
      },
    });
  } catch (error) {
    console.error('❌ [CREATOR] Get withdrawals error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// REAL-TIME SYNC — Emit creator:data_updated via Socket.IO
// ══════════════════════════════════════════════════════════════════════════

/**
 * Emit `creator:data_updated` to a specific creator's socket room.
 *
 * Called after:
 * - Billing settlement (call ends → earnings/coins changed)
 * - Task reward claim (coins changed, task state changed)
 *
 * The frontend listens for this event and refreshes all creator data.
 */
export function emitCreatorDataUpdated(
  creatorFirebaseUid: string,
  payload: {
    reason: string;
    [key: string]: any;
  }
): void {
  try {
    const io = getIO();
    io.to(`user:${creatorFirebaseUid}`).emit('creator:data_updated', {
      ...payload,
      timestamp: new Date().toISOString(),
    });
    console.log(
      `📡 [CREATOR] Emitted creator:data_updated to ${creatorFirebaseUid} (reason: ${payload.reason})`
    );
  } catch (err) {
    console.error('⚠️ [CREATOR] Failed to emit creator:data_updated:', err);
  }
}
