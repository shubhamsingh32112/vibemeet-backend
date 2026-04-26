import type { Request } from 'express';
import { Response } from 'express';
import mongoose from 'mongoose';
import { Creator } from './creator.model';
import { User } from '../user/user.model';
import { CreatorTaskProgress, ICreatorTaskProgress } from './creator-task.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { CallHistory } from '../billing/call-history.model';
import { CREATOR_TASKS, getTaskByKey, isValidTaskKey, getDailyPeriodBounds } from './creator-tasks.config';
import { getIO } from '../../config/socket';
import { emitCreatorDataUpdated } from './creator-notify';
import { setCreatorAvailability } from '../availability/availability.gateway';
import { getBatchAvailability } from '../availability/availability.service';
import {
  getRedis,
  creatorDashboardKey,
  CREATOR_DASHBOARD_TTL,
  invalidateCreatorDashboard,
  invalidateAdminCaches,
  creatorTasksKey,
  CREATOR_TASKS_TTL,
  invalidateCreatorTasks,
} from '../../config/redis';
import { verifyUserBalance } from '../../utils/balance-integrity';
import { Withdrawal } from './withdrawal.model';
import { emitToAdmin } from '../admin/admin.gateway';
import { assertAdminOrOwningAgentForCreator } from '../../middlewares/staff.middleware';
import {
  CREATOR_GALLERY_MAX_IMAGES,
  CREATOR_GALLERY_MIN_IMAGES,
  CREATOR_GALLERY_ALLOWED_CONTENT_TYPES,
} from './creator-gallery.constants';
import {
  buildPublicGalleryDownloadUrl,
  createCreatorGallerySignedUpload,
  deleteGalleryStorageObject,
  isAllowedGalleryContentType,
  parseGalleryStoragePath,
} from './creator-gallery.storage';
import { logError, logInfo } from '../../utils/logger';
import { ensureCreatorPromotionBonusReversalEntry } from './creator-starter.service';
import { ensureStreamUser } from '../../config/stream';
import { getStreamUpsertPayload } from '../../utils/stream-user-payload';
import { invalidateOtherMemberCacheForFirebaseUid } from '../chat/chat-cache-invalidation';
import { normalizeGalleryImages, resolveGalleryImageUrlsForApi } from './creator-gallery-resolve';
import { validateCreatorPriceForApi } from '../../config/creator-price.config';
import { invalidateCreatorPricingCache } from '../video/pricing.service';
import { CREATOR_SHARE_PERCENTAGE } from '../../config/pricing.config';
import {
  parseCreatorLocationForCreate,
  parseCreatorLocationForUpdate,
} from './creator-location.util';

// Get all creators (for users to see - excludes other creators)
export const getAllCreators = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('📋 [CREATOR] Get all creators request');
    
    // Check if user is authenticated and get their role
    let currentUser = null;
    if (req.auth) {
      currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    }
    
    // Only consumers (role user) may list the public creator catalog.
    // Creators, agents (dashboard JWT), and admins must not use this aggregate feed.
    if (currentUser && currentUser.role === 'creator') {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Creators cannot view other creators. Use /user/list to view users.',
      });
      return;
    }
    if (currentUser && currentUser.role === 'agent') {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Use GET /agent/creators for your assigned creators.',
      });
      return;
    }
    
    const hasPaginationQuery =
      req.query.page !== undefined || req.query.limit !== undefined;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(
      500,
      Math.max(1, parseInt(req.query.limit as string) || 100),
    );
    const skip = (page - 1) * limit;

    // Return ALL creators by default (backward-compatible).
    // If page/limit is passed, return paginated data for frontend scale paths.
    const baseQuery = Creator.find({}).sort({ createdAt: -1 });
    const query = hasPaginationQuery ? baseQuery.skip(skip).limit(limit) : baseQuery;
    const creators = await query.lean();
    const total = hasPaginationQuery ? await Creator.countDocuments({}) : creators.length;
    
    console.log(
      `✅ [CREATOR] Found ${creators.length} creator(s) (page=${page}, limit=${limit}, total=${total})`,
    );

    // Favorites are a "user-only" feature
    const favoriteSet =
      currentUser && currentUser.role === 'user'
        ? new Set((currentUser.favoriteCreatorIds || []).map((id) => id.toString()))
        : new Set<string>();
    
    // Build a userId -> firebaseUid map in one query (avoids N+1 creator-user lookups).
    const userIds = creators
      .map((creator) => creator.userId)
      .filter((id): id is mongoose.Types.ObjectId => Boolean(id));
    const linkedUsers = userIds.length
      ? await User.find({ _id: { $in: userIds } }).select('_id firebaseUid').lean()
      : [];
    const firebaseUidByUserId = new Map(
      linkedUsers.map((u) => [u._id.toString(), u.firebaseUid || null] as const)
    );

    // Resolve gallery URLs for response only (no write-on-read in hot feed endpoint).
    const creatorsWithUserIds = await Promise.all(
      creators.map(async (creator) => {
        const { galleryImages } = await resolveGalleryImageUrlsForApi(creator.galleryImages);
        return {
          id: creator._id.toString(),
          userId: creator.userId ? creator.userId.toString() : null, // MongoDB User ID
          firebaseUid: creator.userId ? (firebaseUidByUserId.get(creator.userId.toString()) ?? null) : null,
          name: creator.name,
          about: creator.about,
          photo: creator.photo,
          galleryImages,
          categories: creator.categories,
          price: creator.price,
          age: creator.age,
          location: creator.location,
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
    
    res.json({
      success: true,
      data: {
        creators: creatorsWithAvailability,
        ...(hasPaginationQuery
          ? {
              pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
              },
            }
          : {}),
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

    const { galleryImages, urlsChanged } = await resolveGalleryImageUrlsForApi(creator.galleryImages);
    if (urlsChanged) {
      await Creator.updateOne({ _id: creator._id }, { $set: { galleryImages } });
    }

    res.json({
      success: true,
      data: {
        creator: {
          id: creator._id.toString(),
          userId: creator.userId ? creator.userId.toString() : null, // User ID for initiating calls
          name: creator.name,
          about: creator.about,
          photo: creator.photo,
          galleryImages,
          categories: creator.categories,
          price: creator.price,
          age: creator.age,
          location: creator.location,
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
    
    const { name, about, photo, userId, categories, price, age, location } = req.body;
    
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
    
    const priceCheck = validateCreatorPriceForApi(price);
    if (!priceCheck.ok) {
      res.status(400).json({ success: false, error: priceCheck.error });
      return;
    }
    const validatedPrice = priceCheck.price;
    
    if (age !== undefined && (typeof age !== 'number' || age < 18 || age > 100)) {
      res.status(400).json({
        success: false,
        error: 'Age must be a number between 18 and 100',
      });
      return;
    }

    const locCreate = parseCreatorLocationForCreate(location);
    if (!locCreate.ok) {
      res.status(400).json({ success: false, error: locCreate.error });
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
    
    const session = await mongoose.startSession();
    let creator;
    try {
      session.startTransaction();

      targetUser.welcomeBonusClaimed = true;
      targetUser.coins = 0;
      if (targetUser.role !== 'creator' && targetUser.role !== 'admin') {
        targetUser.role = 'creator';
      }
      await targetUser.save({ session });
      await ensureCreatorPromotionBonusReversalEntry(targetUser, session);

      const created = await Creator.create(
        [{
          name,
          about,
          photo,
          galleryImages: [],
          userId: targetUser._id,
          categories: Array.isArray(categories) ? categories : [],
          price: validatedPrice,
          age: age !== undefined ? age : undefined,
          ...(locCreate.value !== undefined ? { location: locCreate.value } : {}),
        }],
        { session }
      );
      creator = created[0];

      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      await session.endSession();
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
          galleryImages: normalizeGalleryImages(creator.galleryImages),
          categories: creator.categories,
          price: creator.price,
          age: creator.age,
          location: creator.location,
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

/** Stream + socket + admin cache after creator-linked profile data changed (DB already saved). */
export async function notifyCreatorProfileChannels(
  userMongoId: mongoose.Types.ObjectId | string,
  firebaseUid: string,
): Promise<void> {
  const uid = typeof userMongoId === 'string' ? userMongoId : userMongoId.toString();
  invalidateCreatorDashboard(uid).catch(() => {});

  try {
    const freshUser = await User.findById(uid);
    if (freshUser) {
      const streamPayload = await getStreamUpsertPayload(freshUser);
      await ensureStreamUser(freshUser.firebaseUid, streamPayload);
      await invalidateOtherMemberCacheForFirebaseUid(freshUser.firebaseUid);
    }
  } catch (syncErr) {
    console.error('⚠️ [CREATOR] Stream/cache sync after profile update failed:', syncErr);
  }

  emitCreatorDataUpdated(firebaseUid, { reason: 'profile_updated' });
  invalidateAdminCaches('overview', 'creators_performance').catch(() => {});
}

/**
 * After admin edits creator profile (or linked user / gallery): bump profileRevision,
 * sync Stream, emit creator:data_updated, invalidate caches.
 */
export async function bumpCreatorProfileRevisionForAdmin(
  userMongoId: mongoose.Types.ObjectId | string,
  options?: { syncAvatarFromCreatorPhoto?: string },
): Promise<void> {
  const id = typeof userMongoId === 'string' ? userMongoId : userMongoId.toString();
  const user = await User.findById(id);
  if (!user?.firebaseUid) return;

  if (options?.syncAvatarFromCreatorPhoto !== undefined) {
    const p = options.syncAvatarFromCreatorPhoto.trim();
    if (p) user.avatar = p;
  }

  user.profileRevision = (user.profileRevision ?? 0) + 1;
  await user.save();

  await notifyCreatorProfileChannels(user._id, user.firebaseUid);
}

// Update creator (Admin only) — updates Creator; mirrors main photo to User.avatar when photo sent; notifies app
export const updateCreator = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    console.log(`✏️ [CREATOR] Update creator: ${id}`);

    if (!(await assertAdminOrOwningAgentForCreator(req, res, id))) return;

    const { name, about, photo, categories, price, age, location } = req.body;
    
    const creator = await Creator.findById(id);
    if (!creator) {
      res.status(404).json({
        success: false,
        error: 'Creator not found',
      });
      return;
    }
    
    if (!creator.userId) {
      res.status(400).json({
        success: false,
        error: 'Creator has no linked user',
      });
      return;
    }
    
    const photoInBody = photo !== undefined && photo !== null;
    
    if (name) creator.name = name;
    if (about) creator.about = about;
    if (photoInBody) creator.photo = typeof photo === 'string' ? photo.trim() : String(photo);
    
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
    if (price !== undefined) {
      const priceCheck = validateCreatorPriceForApi(price);
      if (!priceCheck.ok) {
        res.status(400).json({ success: false, error: priceCheck.error });
        return;
      }
      creator.price = priceCheck.price;
    }
    if (age !== undefined) {
      if (typeof age !== 'number' || age < 18 || age > 100) {
        res.status(400).json({
          success: false,
          error: 'Age must be a number between 18 and 100',
        });
        return;
      }
      creator.age = age;
    }

    const locUpdate = parseCreatorLocationForUpdate(location);
    if (locUpdate.kind === 'error') {
      res.status(400).json({ success: false, error: locUpdate.message });
      return;
    }
    if (locUpdate.kind === 'clear') {
      creator.set('location', undefined);
    } else if (locUpdate.kind === 'set') {
      creator.location = locUpdate.value;
    }
    
    await creator.save();

    if (price !== undefined) {
      await invalidateCreatorPricingCache(creator._id.toString());
    }
    
    await bumpCreatorProfileRevisionForAdmin(creator.userId, {
      syncAvatarFromCreatorPhoto: photoInBody ? creator.photo : undefined,
    });
    
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
          galleryImages: normalizeGalleryImages(creator.galleryImages),
          categories: creator.categories,
          price: creator.price,
          age: creator.age,
          location: creator.location,
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

// Delete creator — admin may delete any; owning agent may delete assigned creators only.
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
    
    const staffUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!staffUser) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
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

    let allowed = false;
    if (staffUser.role === 'admin') {
      allowed = true;
    } else if (staffUser.role === 'agent' && !staffUser.agentDisabled && creator.assignedAgentId?.equals(staffUser._id)) {
      allowed = true;
    }
    if (!allowed) {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Admin access or ownership of this creator is required',
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
      
      const actorLabel =
        staffUser.role === 'admin'
          ? `Admin: ${staffUser._id} (${staffUser.email || staffUser.phone})`
          : `Agent: ${staffUser._id} (${staffUser.email || staffUser.phone})`;
      console.log(`📝 [AUDIT] CREATOR_PROFILE_DELETED`);
      console.log(`   ${actorLabel}`);
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

// Set creator online status (DEPRECATED - Status is now automatic)
// 🔥 NOTE: Creator status is now AUTOMATIC based on socket connection
// - When creator opens app → socket connects → automatically online
// - When creator closes app → socket disconnects → automatically offline
// This endpoint is kept for backward compatibility but status is managed automatically
export const setCreatorOnlineStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const { isOnline } = req.body;
    console.log(`🔄 [CREATOR] Set online status request (DEPRECATED - status is automatic): ${isOnline}`);
    
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

// Update creator profile (Creator only - can update their own profile)
export const updateMyCreatorProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('✏️ [CREATOR] Update my creator profile request');
    
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
    
    // Only creators can update their own profile
    if (currentUser.role !== 'creator' && currentUser.role !== 'admin') {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Only creators can update their profile',
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
    
    const { name, about, age, categories, photo, location } = req.body;
    console.log('📝 [CREATOR] Update request body:', JSON.stringify({ name, about, age, categories, location, photo: photo ? 'present' : 'missing' }));
    let updated = false;
    
    // Update name
    if (name !== undefined && name !== null) {
      if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100) {
        console.log('❌ [CREATOR] Name validation failed:', { type: typeof name, length: typeof name === 'string' ? name.length : 'N/A', value: name });
        res.status(400).json({
          success: false,
          error: 'Name must be between 2 and 100 characters',
        });
        return;
      }
      creator.name = name.trim();
      updated = true;
    }
    
    // Update about
    if (about !== undefined && about !== null) {
      if (typeof about !== 'string' || about.trim().length < 10 || about.trim().length > 1000) {
        console.log('❌ [CREATOR] About validation failed:', { type: typeof about, length: typeof about === 'string' ? about.length : 'N/A', value: about });
        res.status(400).json({
          success: false,
          error: 'About must be between 10 and 1000 characters',
        });
        return;
      }
      creator.about = about.trim();
      updated = true;
    }
    
    // Update age
    if (age !== undefined && age !== null) {
      // Handle both number and string age (JSON might send as string)
      const ageNum = typeof age === 'string' ? parseInt(age, 10) : age;
      if (isNaN(ageNum) || ageNum < 18 || ageNum > 100) {
        console.log('❌ [CREATOR] Age validation failed:', { type: typeof age, value: age, parsed: ageNum });
        res.status(400).json({
          success: false,
          error: 'Age must be a number between 18 and 100',
        });
        return;
      }
      creator.age = ageNum;
      updated = true;
    }
    
    // Update photo
    if (photo !== undefined && photo !== null) {
      if (typeof photo !== 'string' || photo.trim().length === 0) {
        console.log('❌ [CREATOR] Photo validation failed:', { type: typeof photo, length: typeof photo === 'string' ? photo.length : 'N/A' });
        res.status(400).json({
          success: false,
          error: 'Photo must be a non-empty string',
        });
        return;
      }
      creator.photo = photo.trim();
      updated = true;
    }
    
    // Update categories
    if (categories !== undefined && categories !== null) {
      if (!Array.isArray(categories)) {
        console.log('❌ [CREATOR] Categories validation failed: not an array', { type: typeof categories, value: categories });
        res.status(400).json({
          success: false,
          error: 'Categories must be an array of strings',
        });
        return;
      }
      if (categories.some((c) => typeof c !== 'string')) {
        console.log('❌ [CREATOR] Categories validation failed: contains non-string values', { categories });
        res.status(400).json({
          success: false,
          error: 'Categories must be an array of strings',
        });
        return;
      }
      creator.categories = categories;
      updated = true;
    }

    const locUp = parseCreatorLocationForUpdate(location);
    if (locUp.kind === 'error') {
      res.status(400).json({ success: false, error: locUp.message });
      return;
    }
    if (locUp.kind === 'clear') {
      creator.set('location', undefined);
      updated = true;
    } else if (locUp.kind === 'set') {
      creator.location = locUp.value;
      updated = true;
    }
    
    if (!updated) {
      res.status(400).json({
        success: false,
        error: 'No fields to update',
      });
      return;
    }
    
    await creator.save();

    const { galleryImages: resolvedGallery, urlsChanged } = await resolveGalleryImageUrlsForApi(
      creator.galleryImages,
    );
    if (urlsChanged) {
      await Creator.updateOne({ _id: creator._id }, { $set: { galleryImages: resolvedGallery } });
    }

    // Keep User.avatar aligned with creator photo so legacy paths + Stream stay consistent
    const photoInRequest = photo !== undefined && photo !== null;
    if (photoInRequest && creator.photo?.trim()) {
      currentUser.avatar = creator.photo.trim();
      await currentUser.save();
    }

    // Invalidate creator dashboard cache
    invalidateCreatorDashboard(currentUser._id.toString()).catch(() => {});

    try {
      const freshUser = await User.findById(currentUser._id);
      if (freshUser) {
        const streamPayload = await getStreamUpsertPayload(freshUser);
        await ensureStreamUser(freshUser.firebaseUid, streamPayload);
        await invalidateOtherMemberCacheForFirebaseUid(freshUser.firebaseUid);
      }
    } catch (syncErr) {
      console.error('⚠️ [CREATOR] Stream/cache sync after profile update failed:', syncErr);
    }

    try {
      emitCreatorDataUpdated(currentUser.firebaseUid, { reason: 'profile_updated' });
    } catch (emitErr) {
      console.error('⚠️ [CREATOR] Failed to emit profile_updated:', emitErr);
    }

    console.log(`✅ [CREATOR] Creator profile updated: ${creator._id}`);

    res.json({
      success: true,
      data: {
        creator: {
          id: creator._id.toString(),
          userId: creator.userId.toString(),
          name: creator.name,
          about: creator.about,
          photo: creator.photo,
          galleryImages: resolvedGallery,
          age: creator.age,
          categories: creator.categories,
          price: creator.price,
          location: creator.location,
          createdAt: creator.createdAt,
          updatedAt: creator.updatedAt,
        },
      },
    });
  } catch (error) {
    console.error('❌ [CREATOR] Update my creator profile error:', error);
    console.error('❌ [CREATOR] Error details:', {
      name: error instanceof Error ? error.name : 'Unknown',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
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

export const getMyCreatorProfile = async (req: Request, res: Response): Promise<void> => {
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
      res.status(403).json({ success: false, error: 'Forbidden: Only creators can view profile' });
      return;
    }

    const creator = await Creator.findOne({ userId: currentUser._id });
    if (!creator) {
      res.status(404).json({ success: false, error: 'Creator profile not found' });
      return;
    }

    const { galleryImages, urlsChanged } = await resolveGalleryImageUrlsForApi(creator.galleryImages);
    if (urlsChanged) {
      await Creator.updateOne({ _id: creator._id }, { $set: { galleryImages } });
    }

    res.json({
      success: true,
      data: {
        creator: {
          id: creator._id.toString(),
          userId: creator.userId.toString(),
          name: creator.name,
          about: creator.about,
          photo: creator.photo,
          galleryImages,
          age: creator.age,
          categories: creator.categories,
          price: creator.price,
          location: creator.location,
          createdAt: creator.createdAt,
          updatedAt: creator.updatedAt,
        },
      },
    });
  } catch (error) {
    logError('Get my creator profile error', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const createGalleryUploadUrl = async (req: Request, res: Response): Promise<void> => {
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
      res.status(403).json({ success: false, error: 'Forbidden: Only creators can upload gallery images' });
      return;
    }

    const creator = await Creator.findOne({ userId: currentUser._id });
    if (!creator) {
      res.status(404).json({ success: false, error: 'Creator profile not found' });
      return;
    }
    if ((creator.galleryImages?.length ?? 0) >= CREATOR_GALLERY_MAX_IMAGES) {
      res.status(409).json({
        success: false,
        error: `Maximum ${CREATOR_GALLERY_MAX_IMAGES} gallery images allowed`,
      });
      return;
    }

    const contentType = req.body?.contentType;
    if (!isAllowedGalleryContentType(contentType)) {
      res.status(400).json({
        success: false,
        error: `contentType must be one of: ${CREATOR_GALLERY_ALLOWED_CONTENT_TYPES.join(', ')}`,
      });
      return;
    }

    const signedUpload = await createCreatorGallerySignedUpload(creator._id.toString(), contentType);
    logInfo('Creator gallery upload URL created', {
      creatorId: creator._id.toString(),
      imageId: signedUpload.imageId,
      storagePath: signedUpload.storagePath,
      contentType,
    });

    res.status(201).json({
      success: true,
      data: signedUpload,
    });
  } catch (error) {
    logError('Create gallery upload URL error', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const commitGalleryImage = async (req: Request, res: Response): Promise<void> => {
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
      res.status(403).json({ success: false, error: 'Forbidden: Only creators can commit gallery images' });
      return;
    }

    const creator = await Creator.findOne({ userId: currentUser._id });
    if (!creator) {
      res.status(404).json({ success: false, error: 'Creator profile not found' });
      return;
    }

    const { imageId, storagePath } = req.body ?? {};
    if (
      typeof imageId !== 'string' ||
      typeof storagePath !== 'string' ||
      imageId.trim() === '' ||
      storagePath.trim() === ''
    ) {
      res.status(400).json({
        success: false,
        error: 'imageId and storagePath are required',
      });
      return;
    }

    const parsed = parseGalleryStoragePath(storagePath.trim());
    if (!parsed || parsed.creatorId !== creator._id.toString() || parsed.imageId !== imageId.trim()) {
      res.status(422).json({ success: false, error: 'storagePath/imageId mismatch for this creator' });
      return;
    }

    let url: string;
    try {
      url = await buildPublicGalleryDownloadUrl(storagePath.trim());
    } catch (e) {
      logError('Gallery commit: object missing or unreadable in Storage', e, {
        storagePath: storagePath.trim(),
        imageId: imageId.trim(),
      });
      res.status(400).json({
        success: false,
        error: 'Upload not found in storage. Finish the upload, then try commit again.',
      });
      return;
    }

    const existingImages = normalizeGalleryImages(creator.galleryImages);
    if (!existingImages.some((img) => img.id === imageId.trim())) {
      if (existingImages.length >= CREATOR_GALLERY_MAX_IMAGES) {
        res.status(409).json({
          success: false,
          error: `Maximum ${CREATOR_GALLERY_MAX_IMAGES} gallery images allowed`,
        });
        return;
      }
      existingImages.push({
        id: imageId.trim(),
        storagePath: storagePath.trim(),
        url,
        createdAt: new Date(),
        position: existingImages.length,
      });
    } else {
      for (let i = 0; i < existingImages.length; i += 1) {
        if (existingImages[i].id === imageId.trim()) {
          existingImages[i] = {
            ...existingImages[i],
            storagePath: storagePath.trim(),
            url,
          };
          break;
        }
      }
    }

    creator.galleryImages = normalizeGalleryImages(existingImages);
    await creator.save();

    res.json({
      success: true,
      data: {
        galleryImages: normalizeGalleryImages(creator.galleryImages),
      },
    });
  } catch (error) {
    logError('Commit gallery image error', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const deleteGalleryImage = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const { imageId } = req.params;
    if (!imageId || imageId.trim() === '') {
      res.status(400).json({ success: false, error: 'imageId is required' });
      return;
    }

    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    if (currentUser.role !== 'creator' && currentUser.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Forbidden: Only creators can delete gallery images' });
      return;
    }

    const creator = await Creator.findOne({ userId: currentUser._id });
    if (!creator) {
      res.status(404).json({ success: false, error: 'Creator profile not found' });
      return;
    }

    const existingImages = normalizeGalleryImages(creator.galleryImages);
    const target = existingImages.find((img) => img.id === imageId.trim());
    if (!target) {
      res.status(404).json({ success: false, error: 'Gallery image not found' });
      return;
    }

    if (existingImages.length <= CREATOR_GALLERY_MIN_IMAGES) {
      res.status(400).json({
        success: false,
        error: `At least ${CREATOR_GALLERY_MIN_IMAGES} gallery image is required`,
      });
      return;
    }

    creator.galleryImages = normalizeGalleryImages(
      existingImages.filter((img) => img.id !== imageId.trim()),
    );
    await creator.save();

    deleteGalleryStorageObject(target.storagePath).catch((err) => {
      logError('Failed to delete gallery storage object', err, {
        creatorId: creator._id.toString(),
        imageId: target.id,
        storagePath: target.storagePath,
      });
    });

    res.json({
      success: true,
      data: {
        galleryImages: normalizeGalleryImages(creator.galleryImages),
      },
    });
  } catch (error) {
    logError('Delete gallery image error', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const reorderGalleryImages = async (req: Request, res: Response): Promise<void> => {
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
      res.status(403).json({ success: false, error: 'Forbidden: Only creators can reorder gallery images' });
      return;
    }
    const creator = await Creator.findOne({ userId: currentUser._id });
    if (!creator) {
      res.status(404).json({ success: false, error: 'Creator profile not found' });
      return;
    }

    const imageIds = req.body?.imageIds;
    if (!Array.isArray(imageIds) || imageIds.some((id) => typeof id !== 'string' || id.trim() === '')) {
      res.status(400).json({ success: false, error: 'imageIds must be a non-empty array of strings' });
      return;
    }

    const existingImages = normalizeGalleryImages(creator.galleryImages);
    if (imageIds.length !== existingImages.length) {
      res.status(400).json({ success: false, error: 'imageIds length mismatch with existing gallery images' });
      return;
    }

    const existingIdSet = new Set(existingImages.map((img) => img.id));
    for (const id of imageIds) {
      if (!existingIdSet.has(id.trim())) {
        res.status(422).json({ success: false, error: `Unknown imageId in reorder payload: ${id}` });
        return;
      }
    }

    const imageMap = new Map(existingImages.map((img) => [img.id, img]));
    creator.galleryImages = imageIds.map((id: string, index: number) => ({
      ...imageMap.get(id.trim())!,
      position: index,
    }));
    await creator.save();

    res.json({
      success: true,
      data: {
        galleryImages: normalizeGalleryImages(creator.galleryImages),
      },
    });
  } catch (error) {
    logError('Reorder gallery images error', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
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

    // Aggregate all-time summary directly in MongoDB to avoid loading full history into memory.
    const summaryAgg = await CallHistory.aggregate([
      {
        $match: {
          ownerUserId: currentUser._id,
          ownerRole: 'creator',
          durationSeconds: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: null,
          totalEarnings: { $sum: '$coinsEarned' },
          totalSeconds: { $sum: '$durationSeconds' },
          totalCalls: { $sum: 1 },
        },
      },
    ]);

    const summary = summaryAgg[0] || { totalEarnings: 0, totalSeconds: 0, totalCalls: 0 };
    const totalEarnings = summary.totalEarnings || 0;
    const totalSeconds = summary.totalSeconds || 0;
    const totalMinutes = totalSeconds / 60;
    const totalCalls = summary.totalCalls || 0;
    const avgEarningsPerMinute = totalMinutes > 0 ? totalEarnings / totalMinutes : 0;
    const earningsPerMinute = creator.price * CREATOR_SHARE_PERCENTAGE;

    const recentCallRecords = await CallHistory.find({
      ownerUserId: currentUser._id,
      ownerRole: 'creator',
      durationSeconds: { $gt: 0 },
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const calls = recentCallRecords.map((call) => {
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
        creatorSharePercentage: CREATOR_SHARE_PERCENTAGE,
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

    // ── Try Redis cache first ────────────────────────────────────────────
    const cacheKey = creatorTasksKey(currentUser._id.toString());
    try {
      const redis = getRedis();
      const cached = await redis.get(cacheKey);
      if (cached) {
        const data = typeof cached === 'string' ? JSON.parse(cached) : cached;
        console.log('⚡ [CREATOR] Tasks served from Redis cache');
        res.json({ success: true, data });
        return;
      }
    } catch (cacheErr) {
      console.error('⚠️ [CREATOR] Redis cache read failed:', cacheErr);
      // Continue to database query on cache failure
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

    const responseData = {
      totalMinutes: Math.round(totalMinutes * 100) / 100, // Round to 2 decimals
      tasks,
      resetsAt: resetsAt.toISOString(),
    };

    // ── Cache in Redis ───────────────────────────────────────────────────
    try {
      const redis = getRedis();
      await redis.setex(cacheKey, CREATOR_TASKS_TTL, JSON.stringify(responseData));
      console.log('💾 [CREATOR] Tasks cached in Redis');
    } catch (cacheErr) {
      console.error('⚠️ [CREATOR] Redis cache write failed:', cacheErr);
      // Continue even if cache write fails
    }

    res.json({
      success: true,
      data: responseData,
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

    // 🔥 SCALABILITY FIX: Invalidate tasks and dashboard cache after claim
    try {
      await invalidateCreatorTasks(currentUser._id.toString());
      await invalidateCreatorDashboard(currentUser._id.toString());
    } catch (cacheErr) {
      console.error('⚠️ [CREATOR] Failed to invalidate caches after task claim:', cacheErr);
      // Continue even if cache invalidation fails
    }

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
      const cached = await redis.get(cacheKey);
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

    // 1. Earnings summary (all-time) from aggregation instead of full-history in-memory reduction.
    const allTimeSummaryAgg = await CallHistory.aggregate([
      {
        $match: {
          ownerUserId: currentUser._id,
          ownerRole: 'creator',
          durationSeconds: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: null,
          totalEarnings: { $sum: '$coinsEarned' },
          totalSeconds: { $sum: '$durationSeconds' },
          totalCalls: { $sum: 1 },
        },
      },
    ]);
    const allTimeSummary = allTimeSummaryAgg[0] || { totalEarnings: 0, totalSeconds: 0, totalCalls: 0 };
    const totalEarnings = allTimeSummary.totalEarnings || 0;
    const totalSeconds = allTimeSummary.totalSeconds || 0;
    const allTimeMinutes = totalSeconds / 60;
    const totalCalls = allTimeSummary.totalCalls || 0;
    const earningsPerMinute = creator.price * CREATOR_SHARE_PERCENTAGE;
    const avgEarningsPerMinute = allTimeMinutes > 0 ? totalEarnings / allTimeMinutes : 0;

    const recentCallRecords = await CallHistory.find({
      ownerUserId: currentUser._id,
      ownerRole: 'creator',
      durationSeconds: { $gt: 0 },
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    const recentCalls = recentCallRecords.map((call) => {
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
        creatorSharePercentage: CREATOR_SHARE_PERCENTAGE,
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
        location: creator.location,
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

    const creatorProfile = await Creator.findOne({ userId: currentUser._id })
      .select('_id assignedAgentId')
      .lean();
    if (!creatorProfile) {
      res.status(404).json({ success: false, error: 'Creator profile not found' });
      return;
    }

    const assignedAgentId = creatorProfile.assignedAgentId ?? undefined;
    if (!assignedAgentId) {
      logInfo('withdrawal_created_without_assignment', {
        creatorUserId: currentUser._id.toString(),
        creatorId: creatorProfile._id.toString(),
      });
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
      assignedAgentId,
    });

    console.log(`✅ [CREATOR] Withdrawal requested: ${withdrawal._id} for ${amount} coins by user ${currentUser._id}`);

    // Emit to admin dashboard
    emitToAdmin('withdrawal:requested', {
      withdrawalId: withdrawal._id.toString(),
      creatorUserId: currentUser._id.toString(),
      amount,
    });

    invalidateAdminCaches('overview', 'creators_performance').catch(() => {});

    res.status(201).json({
      success: true,
      data: {
        withdrawalId: withdrawal._id.toString(),
        amount: withdrawal.amount,
        status: withdrawal.status,
        requestedAt: withdrawal.requestedAt.toISOString(),
        name: withdrawal.name ?? null,
        number: withdrawal.number ?? null,
        upi: withdrawal.upi ?? null,
        accountNumber: withdrawal.accountNumber ?? null,
        ifsc: withdrawal.ifsc ?? null,
        assignedAgentId: withdrawal.assignedAgentId?.toString() ?? null,
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
          name: w.name || null,
          number: w.number || null,
          upi: w.upi || null,
          accountNumber: w.accountNumber || null,
          ifsc: w.ifsc || null,
          createdAt: w.createdAt,
        })),
      },
    });
  } catch (error) {
    console.error('❌ [CREATOR] Get withdrawals error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export { emitCreatorDataUpdated } from './creator-notify';
