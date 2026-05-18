import type { Request } from 'express';
import { Response } from 'express';
import mongoose from 'mongoose';
import { User } from './user.model';
import { Creator } from '../creator/creator.model';
import { CoinTransaction } from './coin-transaction.model';
import { CallHistory } from '../billing/call-history.model';
import { DeletedUserPhone } from './deleted-user-phone.model';
import { upsertDeletedIdentities } from './deleted-identity.service';
import { randomUUID } from 'crypto';
import { invalidateAdminCaches } from '../../config/redis';
import { getIO } from '../../config/socket';
import { verifyUserBalance } from '../../utils/balance-integrity';
import { getFirebaseAdmin } from '../../config/firebase';
import { ensureStreamUser } from '../../config/stream';
import {
  getStreamUpsertPayload,
  resolveChatPresentationFromDocs,
} from '../../utils/stream-user-payload';
import { invalidateOtherMemberCacheForFirebaseUid } from '../chat/chat-cache-invalidation';
import { getCreatorApplicationFlagsForUser } from '../agency/creator-application-status.service';
import {
  applyReferralCode,
  assignReferralCodeToUser,
  type ApplyReferralCodeErrorCode,
} from './referral.service';
import { ReferralEdge } from './referral-edge.model';
import { referralUserFacingMessage } from '../../utils/referral-messages';
import { logError } from '../../utils/logger';
import {
  ADMIN_USER_SEARCH_QUERY_MAX_LEN,
  buildSafeMongoSubstringRegex,
} from '../../utils/mongo-regex';
import { validateCreatorPriceForApi } from '../../config/creator-price.config';
import { parseCreatorLocationForCreate } from '../creator/creator-location.util';
import {
  ensureCreatorPromotionBonusReversalEntry,
  promoteUserToCreatorWithStarterProfile,
} from '../creator/creator-starter.service';
import { isAgencyRole, isNonConsumerCoinsRole, isSuperAdminRole } from '../../utils/staff-roles';
import {
  commitImageAsset,
  CommitImageAssetError,
} from '../images/commit-image-asset';
import {
  CloudflareImagesCircuitOpenError,
  CloudflareImagesError,
} from '../images/cloudflare.client';
import {
  safeCloudflareImagesClientError,
  setDegradedHeader,
} from '../images/images.controller';
import { isCloudflareImagesEnabled } from '../../config/cloudflare';
import {
  serializeUserImages,
  serializeCreatorGallery,
  serializeCreatorImages,
} from '../images/creator-image-helpers';
import { makeImageAssetDoc } from '../images/image-asset.schema';
import {
  applyOnboardingStageEvent,
  stageForClient,
  submitPermissionsDecisionEvent,
  type OnboardingStageInput,
  type PermissionStatus,
  type PermissionsDecision,
} from './onboarding-transition.service';

function welcomeFreeCallEligible(user: {
  role: string;
  welcomeFreeCallConsumedAt?: Date | null;
  introFreeCallCredits?: number;
}): boolean {
  return (
    user.role === 'user' &&
    !user.welcomeFreeCallConsumedAt &&
    (Number(user.introFreeCallCredits) || 0) > 0
  );
}

function referralErrorHttpStatus(code: ApplyReferralCodeErrorCode): number {
  return code === 'NOT_FOUND' ? 404 : 400;
}

function buildOnboardingPayload(user: {
  onboardingStage?: string | null;
  onboardingWelcomeSeenAt?: Date | null;
  onboardingBonusSeenAt?: Date | null;
  onboardingPermissionSeenAt?: Date | null;
  onboardingCompletedAt?: Date | null;
  permissionsIntroAcceptedAt?: Date | null;
  permissionOnboardingStatus?: 'accepted' | 'skipped' | 'unknown';
  cameraMicPermissionStatus?: PermissionStatus;
  notificationPermissionStatus?: PermissionStatus;
  permissionsLastCheckedAt?: Date | null;
  onboardingFlowVersion?: number | null;
}) {
  return {
    stage: stageForClient(user.onboardingStage),
    flowVersion: user.onboardingFlowVersion === 2 ? 2 : 1,
    welcomeSeenAt: user.onboardingWelcomeSeenAt ?? null,
    bonusSeenAt: user.onboardingBonusSeenAt ?? null,
    permissionSeenAt: user.onboardingPermissionSeenAt ?? null,
    completedAt: user.onboardingCompletedAt ?? null,
    permissionsIntroAcceptedAt: user.permissionsIntroAcceptedAt ?? null,
    permissionOnboardingStatus: user.permissionOnboardingStatus ?? 'unknown',
    cameraMicStatus: user.cameraMicPermissionStatus ?? 'unknown',
    notificationStatus: user.notificationPermissionStatus ?? 'unknown',
    permissionsLastCheckedAt: user.permissionsLastCheckedAt ?? null,
  };
}

function parseOnboardingFlowVersionHeader(req: Request): number | null {
  const raw =
    typeof req.headers['x-onboarding-flow-version'] === 'string'
      ? req.headers['x-onboarding-flow-version'].trim()
      : '';
  if (raw === '2') return 2;
  if (raw === '1') return 1;
  return null;
}

function parseClientMutationId(req: Request): string | undefined {
  const header =
    typeof req.headers['x-client-mutation-id'] === 'string'
      ? req.headers['x-client-mutation-id'].trim()
      : '';
  const body =
    typeof req.body?.clientMutationId === 'string' ? req.body.clientMutationId.trim() : '';
  const value = header || body;
  if (value.length === 0 || value.length > 160) return undefined;
  return value;
}

function parseClientAppVersion(req: Request): string | undefined {
  const raw =
    typeof req.headers['x-app-version'] === 'string'
      ? req.headers['x-app-version'].trim()
      : typeof req.headers['x-client-version'] === 'string'
        ? req.headers['x-client-version'].trim()
        : '';
  return raw.length > 0 ? raw : undefined;
}

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

export const getFavoriteCreatorProfiles = async (
  req: Request,
  res: Response
): Promise<void> => {
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

    if (user.role !== 'user') {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Only users can view favorite creators',
      });
      return;
    }

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const favoriteIds = (user.favoriteCreatorIds || []).map((id) => id.toString());
    const total = favoriteIds.length;

    if (total === 0) {
      res.json({
        success: true,
        data: {
          creators: [],
          pagination: {
            page,
            limit,
            total: 0,
            totalPages: 0,
          },
        },
      });
      return;
    }

    const start = (page - 1) * limit;
    const pagedIds = favoriteIds.slice(start, start + limit);
    const validObjectIds = pagedIds
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    const creators = validObjectIds.length
      ? await Creator.find({ _id: { $in: validObjectIds } }).lean()
      : [];
    const creatorById = new Map(creators.map((creator) => [creator._id.toString(), creator] as const));
    const orderedCreators = pagedIds
      .map((id) => creatorById.get(id))
      .filter((creator): creator is NonNullable<typeof creator> => Boolean(creator));

    const userIds = orderedCreators
      .map((creator) => creator.userId)
      .filter((id): id is mongoose.Types.ObjectId => Boolean(id));
    const linkedUsers = userIds.length
      ? await User.find({ _id: { $in: userIds } }).select('_id firebaseUid').lean()
      : [];
    const firebaseUidByUserId = new Map(
      linkedUsers.map((u) => [u._id.toString(), u.firebaseUid || null] as const)
    );

    const firebaseUids = orderedCreators
      .map((creator) =>
        creator.userId ? (firebaseUidByUserId.get(creator.userId.toString()) ?? null) : null
      )
      .filter((uid): uid is string => Boolean(uid));

    const { getBatchAvailability } = await import('../availability/availability.service');
    const availabilityMap =
      firebaseUids.length > 0 ? await getBatchAvailability(firebaseUids) : {};

    res.json({
      success: true,
      data: {
        creators: orderedCreators.map((creator) => {
          const firebaseUid = creator.userId
            ? (firebaseUidByUserId.get(creator.userId.toString()) ?? null)
            : null;
          return {
            id: creator._id.toString(),
            userId: creator.userId ? creator.userId.toString() : '',
            firebaseUid,
            name: creator.name,
            about: creator.about,
            galleryImages: creator.galleryImages || [],
            categories: creator.categories,
            price: creator.price,
            age: creator.age,
            location: creator.location,
            isOnline: creator.isOnline,
            availability: firebaseUid ? (availabilityMap[firebaseUid] ?? 'busy') : 'busy',
            isFavorite: true,
            createdAt: creator.createdAt,
            updatedAt: creator.updatedAt,
          };
        }),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('❌ [USER] Get favorite creator profiles error:', error);
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

    // Store phone number before deletion (legacy deletion tracking).
    if (user.phone) {
      try {
        // Upsert: update if exists, create if not
        await DeletedUserPhone.findOneAndUpdate(
          { phone: user.phone },
          {
            phone: user.phone,
            deletedAt: new Date(),
          },
          { upsert: true, new: true }
        );
        console.log(`📝 [USER] Stored phone number for deleted account: ${user.phone}`);
      } catch (phoneError) {
        console.error('⚠️ [USER] Failed to store deleted user phone:', phoneError);
        // Continue with deletion even if phone storage fails
      }
    }

    // Store email/phone identities for deletion tracking.
    try {
      await upsertDeletedIdentities({
        email: user.email ?? null,
        phone: user.phone ?? null,
        deletedAt: new Date(),
      });
      console.log(
        `📝 [USER] Stored deleted identities (email: ${user.email ? 'yes' : 'no'}, phone: ${user.phone ? 'yes' : 'no'})`
      );
    } catch (identityError) {
      console.error('⚠️ [USER] Failed to store deleted identities:', identityError);
      // Continue with deletion even if identity storage fails
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
    const appFlags = await getCreatorApplicationFlagsForUser(user._id);
    const onboarding = buildOnboardingPayload(user);
    const hasAgencyAssignment = !!(creator?.assignedAgencyId);

    // If creator exists, return creator details as primary data
    if (creator) {
      const creatorImages = serializeCreatorImages(creator);
      const userImages = serializeUserImages(user);
      res.json({
        success: true,
        data: {
          // Primary data from creator collection
          id: creator._id.toString(),
          name: creator.name,
          about: creator.about,
          galleryImages: serializeCreatorGallery(creator.galleryImages || []),
          age: creator.age, // Include age field
          location: creator.location,
          email: user.email, // Use user's email (identity comes from user)
          phone: user.phone, // Use user's phone (identity comes from user)
          categories: creator.categories,
          price: creator.price,
          // User-specific data (coins, role, etc.)
          coins: user.coins,
          introFreeCallCredits: Number(user.introFreeCallCredits) || 0,
          welcomeFreeCallEligible: welcomeFreeCallEligible(user),
          role: user.role,
          userId: user._id.toString(), // Reference to user document
          // Additional user fields that might be useful
          gender: user.gender,
          username: user.username,
          avatarAsset: creatorImages.avatar ?? userImages.avatar,
          avatar: user.avatar,
          usernameChangeCount: user.usernameChangeCount,
          blockedCreatorCount: (user.blockedCreatorIds || []).length,
          profileRevision: user.profileRevision ?? 0,
          createdAt: creator.createdAt,
          updatedAt: creator.updatedAt,
          referralCode: user.referralCode ?? undefined,
          creatorApplicationPending: appFlags.creatorApplicationPending,
          creatorApplicationRejected: appFlags.creatorApplicationRejected,
          hostProfileSetupRequired: appFlags.hostProfileSetupRequired,
          onboarding,
          ...(appFlags.creatorApplicationRejectionReason
            ? { creatorApplicationRejectionReason: appFlags.creatorApplicationRejectionReason }
            : {}),
          hasAgencyAssignment,
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
            age: user.age,
            username: user.username,
            avatar: user.avatar,
            categories: user.categories,
            usernameChangeCount: user.usernameChangeCount,
            coins: user.coins,
            introFreeCallCredits: Number(user.introFreeCallCredits) || 0,
            welcomeFreeCallEligible: welcomeFreeCallEligible(user),
            blockedCreatorCount: (user.blockedCreatorIds || []).length,
            role: user.role,
            profileRevision: user.profileRevision ?? 0,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
            referralCode: user.referralCode ?? undefined,
            creatorApplicationPending: appFlags.creatorApplicationPending,
            creatorApplicationRejected: appFlags.creatorApplicationRejected,
            hostProfileSetupRequired: appFlags.hostProfileSetupRequired,
            onboarding,
            ...(appFlags.creatorApplicationRejectionReason
              ? { creatorApplicationRejectionReason: appFlags.creatorApplicationRejectionReason }
              : {}),
          },
          creator: null,
          hasAgencyAssignment: false,
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

/**
 * GET /user/referrals
 * Returns the current user's referral code and list of referred users with reward status.
 */
export const getReferrals = async (req: Request, res: Response): Promise<void> => {
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

    const referralCode = user.referralCode ?? null;
    const edges = await ReferralEdge.find({ referrerId: user._id })
      .sort({ createdAt: -1 })
      .select('referredUserId rewardGranted createdAt')
      .lean();
    const referredUserIds = edges.map((e) => e.referredUserId);
    const referredUsers =
      referredUserIds.length > 0
        ? await User.find({ _id: { $in: referredUserIds } }).select('_id username email').lean()
        : [];
    const userById = new Map(referredUsers.map((u) => [u._id.toString(), u] as const));
    const creatorProfiles =
      referredUserIds.length > 0
        ? await Creator.find({ userId: { $in: referredUserIds } }).select('userId name').lean()
        : [];
    const creatorByUserId = new Map(
      creatorProfiles.map((c) => [c.userId.toString(), c] as const)
    );

    const referrals = edges.map((edge) => {
      const uid = edge.referredUserId.toString();
      const referredUser = userById.get(uid);
      const creatorProfile = creatorByUserId.get(uid);
      const displayName =
        creatorProfile?.name ?? referredUser?.username ?? referredUser?.email?.split('@')[0] ?? 'User';
      return {
        userId: uid,
        name: displayName,
        rewardGranted: edge.rewardGranted ?? false,
        joinedAt: edge.createdAt?.toISOString?.() ?? new Date().toISOString(),
      };
    });

    res.json({
      success: true,
      data: {
        referralCode,
        referrals,
      },
    });
  } catch (error) {
    console.error('❌ [USER] Get referrals error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

export const advanceOnboardingStage = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const stageRaw = req.body?.stage as string | undefined;
    const stage = stageRaw as OnboardingStageInput | undefined;
    if (
      stage !== 'welcome' &&
      stage !== 'bonus' &&
      stage !== 'permission' &&
      stage !== 'permissions' &&
      stage !== 'completed'
    ) {
      res.status(400).json({
        success: false,
        error: 'Invalid onboarding stage',
      });
      return;
    }
    const event =
      stage === 'welcome'
        ? 'welcome_seen'
        : stage === 'bonus'
          ? 'bonus_seen'
          : stage === 'permissions' || stage === 'permission'
            ? 'permissions_not_now'
            : 'permissions_accept';
    const transition = await applyOnboardingStageEvent({
      firebaseUid: req.auth.firebaseUid,
      event,
      idempotencyKey:
        typeof req.headers['x-idempotency-key'] === 'string'
          ? req.headers['x-idempotency-key']
          : undefined,
      clientMutationId: parseClientMutationId(req),
      requestFlowVersion: parseOnboardingFlowVersionHeader(req),
      clientAppVersion: parseClientAppVersion(req),
    });
    const onboardingSessionId =
      typeof req.headers['x-onboarding-session-id'] === 'string'
        ? req.headers['x-onboarding-session-id']
        : undefined;
    // Reject only when invalid and not safely ignored (log-only / soft no-op).
    if (transition.invalidTransition && !transition.ignored) {
      res.status(409).json({
        success: false,
        error: 'Invalid onboarding transition',
        code: 'INVALID_ONBOARDING_TRANSITION',
        reason: transition.invalidReason,
      });
      return;
    }
    const user = transition.user;
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    console.log(
      `📊 [ONBOARDING METRIC] onboarding_stage_transition from=${transition.fromStage} to=${transition.toStage} userId=${user._id.toString()} ignored=${transition.ignored} sessionId=${onboardingSessionId ?? 'none'}`
    );
    console.log(
      `📊 [ONBOARDING METRIC] invalid_transition_rate value=${transition.metrics.invalidTransition ? 1 : 0} userId=${user._id.toString()}`
    );
    console.log(
      `📊 [ONBOARDING METRIC] idempotent_replay_rate value=${transition.metrics.idempotentReplay ? 1 : 0} userId=${user._id.toString()}`
    );
    console.log(
      `📊 [ONBOARDING METRIC] stage_transition_success_rate value=${transition.metrics.success ? 1 : 0} userId=${user._id.toString()}`
    );
    console.log(
      `📊 [ONBOARDING METRIC] atomic_conflict_replay_rate value=${transition.metrics.atomicConflictReplay ? 1 : 0} userId=${user._id.toString()}`
    );
    if (transition.toStage === 'bonus') {
      console.log(`📊 [ONBOARDING METRIC] drop_off_after_welcome userId=${user._id.toString()}`);
    }
    if (transition.toStage === 'permissions') {
      console.log(`📊 [ONBOARDING METRIC] drop_off_after_bonus userId=${user._id.toString()}`);
    }
    if (transition.toStage === 'completed') {
      console.log(`📊 [ONBOARDING METRIC] onboarding_completed userId=${user._id.toString()}`);
    }

    res.json({
      success: true,
      data: {
        ...buildOnboardingPayload(user),
        ignored: transition.ignored,
        idempotentReplay: transition.idempotentReplay ?? false,
      },
    });
  } catch (error) {
    console.error('❌ [USER] advanceOnboardingStage error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const submitOnboardingPermissionsDecision = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const decision = req.body?.decision as PermissionsDecision | undefined;
    const requestIdRaw = req.body?.requestId;
    const requestId = typeof requestIdRaw === 'string' ? requestIdRaw.trim() : '';
    const cameraMicStatus = req.body?.cameraMicStatus as PermissionStatus | undefined;
    const notificationStatus = req.body?.notificationStatus as PermissionStatus | undefined;
    const validStatuses: PermissionStatus[] = [
      'unknown',
      'granted',
      'denied',
      'permanentlyDenied',
    ];
    if (decision !== 'accept' && decision !== 'not_now') {
      res.status(400).json({
        success: false,
        error: 'decision must be either accept or not_now',
      });
      return;
    }
    if (requestId.length === 0) {
      res.status(400).json({
        success: false,
        error: 'requestId is required',
      });
      return;
    }
    if (cameraMicStatus && !validStatuses.includes(cameraMicStatus)) {
      res.status(400).json({ success: false, error: 'Invalid cameraMicStatus' });
      return;
    }
    if (notificationStatus && !validStatuses.includes(notificationStatus)) {
      res.status(400).json({ success: false, error: 'Invalid notificationStatus' });
      return;
    }

    const transition = await submitPermissionsDecisionEvent({
      firebaseUid: req.auth.firebaseUid,
      decision,
      requestId,
      cameraMicStatus,
      notificationStatus,
      clientMutationId: parseClientMutationId(req),
      requestFlowVersion: parseOnboardingFlowVersionHeader(req),
      clientAppVersion: parseClientAppVersion(req),
    });
    const onboardingSessionId =
      typeof req.headers['x-onboarding-session-id'] === 'string'
        ? req.headers['x-onboarding-session-id']
        : undefined;
    if (transition.rolloutFastForward) {
      console.log(
        `📊 [ONBOARDING METRIC] rollout_fast_forward_used userId=${transition.user._id.toString()} sessionId=${onboardingSessionId ?? 'none'}`
      );
    }
    if (transition.invalidTransition && !transition.ignored) {
      res.status(409).json({
        success: false,
        error: 'Invalid onboarding transition',
        code: 'INVALID_ONBOARDING_TRANSITION',
        reason: transition.invalidReason,
      });
      return;
    }
    const user = transition.user;
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    console.log(
      `📊 [ONBOARDING METRIC] permission_decision decision=${decision} cameraMic=${
        user.cameraMicPermissionStatus ?? 'unknown'
      } notifications=${user.notificationPermissionStatus ?? 'unknown'} userId=${user._id.toString()} sessionId=${onboardingSessionId ?? 'none'}`
    );
    console.log(
      `📊 [ONBOARDING METRIC] invalid_transition_rate value=${transition.metrics.invalidTransition ? 1 : 0} userId=${user._id.toString()}`
    );
    console.log(
      `📊 [ONBOARDING METRIC] idempotent_replay_rate value=${transition.metrics.idempotentReplay ? 1 : 0} userId=${user._id.toString()}`
    );
    console.log(
      `📊 [ONBOARDING METRIC] stage_transition_success_rate value=${transition.metrics.success ? 1 : 0} userId=${user._id.toString()}`
    );
    console.log(
      `📊 [ONBOARDING METRIC] atomic_conflict_replay_rate value=${transition.metrics.atomicConflictReplay ? 1 : 0} userId=${user._id.toString()}`
    );
    res.json({
      success: true,
      data: {
        ...buildOnboardingPayload(user),
        ignored: transition.ignored,
        idempotentReplay: transition.idempotentReplay ?? false,
      },
    });
  } catch (error) {
    console.error('❌ [USER] submitOnboardingPermissionsDecision error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const reconcileOnboardingPermissionsStatus = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const requestIdRaw = req.body?.requestId;
    const requestId = typeof requestIdRaw === 'string' ? requestIdRaw.trim() : '';
    const cameraMicStatus = req.body?.cameraMicStatus as PermissionStatus | undefined;
    const notificationStatus = req.body?.notificationStatus as PermissionStatus | undefined;
    const validStatuses: PermissionStatus[] = [
      'unknown',
      'granted',
      'denied',
      'permanentlyDenied',
    ];
    if (requestId.length === 0) {
      res.status(400).json({
        success: false,
        error: 'requestId is required',
      });
      return;
    }
    if (cameraMicStatus && !validStatuses.includes(cameraMicStatus)) {
      res.status(400).json({ success: false, error: 'Invalid cameraMicStatus' });
      return;
    }
    if (notificationStatus && !validStatuses.includes(notificationStatus)) {
      res.status(400).json({ success: false, error: 'Invalid notificationStatus' });
      return;
    }

    // Use the same transition function, which bypasses stage changes when stage=completed.
    const transition = await submitPermissionsDecisionEvent({
      firebaseUid: req.auth.firebaseUid,
      decision: 'accept',
      requestId,
      cameraMicStatus,
      notificationStatus,
    });
    const user = transition.user;
    res.json({
      success: true,
      data: {
        ...buildOnboardingPayload(user),
        ignored: transition.ignored,
        idempotentReplay: transition.idempotentReplay ?? false,
      },
    });
  } catch (error) {
    console.error('❌ [USER] reconcileOnboardingPermissionsStatus error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/**
 * POST /user/referral/apply-agency
 * Apply an agency host referral (logged-in users/creators without agency assignment).
 */
export const applyReferralAgencyPost = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const raw = typeof req.body?.referralCode === 'string' ? req.body.referralCode.trim() : '';
    if (!raw) {
      res.status(400).json({
        success: false,
        error: 'referralCode is required',
        errorCode: 'INVALID_FORMAT',
      });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    if (!user.referralCode) {
      await assignReferralCodeToUser(user);
    }

    const ar = await applyReferralCode(user, raw, { mode: 'agency_host' });
    if (!ar.ok) {
      res.status(referralErrorHttpStatus(ar.code)).json({
        success: false,
        error: referralUserFacingMessage(ar.code),
        errorCode: ar.code,
      });
      return;
    }

    const refreshed = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!refreshed) {
      res.status(500).json({ success: false, error: 'Internal server error' });
      return;
    }

    const appFlags = await getCreatorApplicationFlagsForUser(refreshed._id);

    res.json({
      success: true,
      data: {
        applied: true,
        role: refreshed.role,
        creatorApplicationPending: appFlags.creatorApplicationPending,
        creatorApplicationRejected: appFlags.creatorApplicationRejected,
        hostProfileSetupRequired: appFlags.hostProfileSetupRequired,
        ...(appFlags.creatorApplicationRejectionReason
          ? { creatorApplicationRejectionReason: appFlags.creatorApplicationRejectionReason }
          : {}),
      },
    });
  } catch (error) {
    console.error('❌ [USER] applyReferralAgencyPost error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const applyReferralPost = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const raw = typeof req.body?.referralCode === 'string' ? req.body.referralCode.trim() : '';
    if (!raw) {
      res.status(400).json({
        success: false,
        error: 'referralCode is required',
        errorCode: 'INVALID_FORMAT',
      });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    if (!user.referralCode) {
      await assignReferralCodeToUser(user);
    }

    const ar = await applyReferralCode(user, raw, { mode: 'late_attach' });
    if (!ar.ok) {
      res.status(referralErrorHttpStatus(ar.code)).json({
        success: false,
        error: referralUserFacingMessage(ar.code),
        errorCode: ar.code,
      });
      return;
    }

    const refreshed = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!refreshed) {
      res.status(500).json({ success: false, error: 'Internal server error' });
      return;
    }

    const appFlags = await getCreatorApplicationFlagsForUser(refreshed._id);

    res.json({
      success: true,
      data: {
        applied: true,
        role: refreshed.role,
        creatorApplicationPending: appFlags.creatorApplicationPending,
        creatorApplicationRejected: appFlags.creatorApplicationRejected,
        hostProfileSetupRequired: appFlags.hostProfileSetupRequired,
        ...(appFlags.creatorApplicationRejectionReason
          ? { creatorApplicationRejectionReason: appFlags.creatorApplicationRejectionReason }
          : {}),
      },
    });
  } catch (error) {
    console.error('❌ [USER] applyReferralPost error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
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
    if (currentUser.role !== 'creator' && !isSuperAdminRole(currentUser.role)) {
      console.log('❌ [USER] Forbidden: User is not a creator or admin');
      res.status(403).json({
        success: false,
        error: 'Forbidden: Only creators can view users',
      });
      return;
    }

    // 🔥 SCALABILITY: Add pagination support
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500); // Default 100, max 500
    const page = parseInt(req.query.page as string) || 1;
    const skip = (page - 1) * limit;

    // Get total count for pagination
    const total = await User.countDocuments({
      $or: [
        { role: 'user' },
        { role: { $exists: false } },
        { role: null },
      ],
      firebaseUid: { $ne: req.auth.firebaseUid },
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
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip);

    console.log(`✅ [USER] Found ${users.length} users with role 'user' (page ${page}, limit ${limit}, total ${total})`);

    // 🔥 NEW: Get online status from Redis for all users
    const { getBatchUserAvailability } = await import('../availability/user-availability.service');
    const firebaseUids = users.map(u => u.firebaseUid).filter(Boolean) as string[];
    const availabilityMap = await getBatchUserAvailability(firebaseUids);

    res.json({
      success: true,
      data: {
        users: users.map((user) => {
          const { avatar } = serializeUserImages(user);
          return {
          id: user._id.toString(),
          username: user.username,
          avatar,
          gender: user.gender,
          categories: user.categories || [],
          firebaseUid: user.firebaseUid, // Include firebaseUid for video calls
          createdAt: user.createdAt,
          // 🔥 NEW: Include online status from Redis
          availability: user.firebaseUid ? (availabilityMap[user.firebaseUid] || 'offline') : 'offline',
        };
        }),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
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
    if (!adminUser || !isSuperAdminRole(adminUser.role)) {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Admin access required',
      });
      return;
    }

    const { query, role } = req.query;
    const searchQuery = typeof query === 'string' ? query : undefined;
    const roleFilter = typeof role === 'string' ? role : undefined;

    if (searchQuery && searchQuery.trim().length > ADMIN_USER_SEARCH_QUERY_MAX_LEN) {
      res.status(400).json({
        success: false,
        error: `Search query must be at most ${ADMIN_USER_SEARCH_QUERY_MAX_LEN} characters`,
      });
      return;
    }

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
      const searchRegex = buildSafeMongoSubstringRegex(searchQuery.trim());
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
    const { name, about, photo, categories, price, location } = req.body ?? {};

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
    if (!adminUser || !isSuperAdminRole(adminUser.role)) {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Admin access required',
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

    const hasLegacyProfile =
      typeof name === 'string' &&
      name.trim().length >= 2 &&
      typeof about === 'string' &&
      about.trim().length >= 10 &&
      typeof photo === 'string' &&
      photo.trim().length > 0 &&
      price !== undefined &&
      price !== null;

    let validatedPrice: number | undefined;
    let legacyLocation: string | undefined;

    if (hasLegacyProfile) {
      const priceCheck = validateCreatorPriceForApi(price);
      if (!priceCheck.ok) {
        res.status(400).json({ success: false, error: priceCheck.error });
        return;
      }
      validatedPrice = priceCheck.price;

      const locParsed = parseCreatorLocationForCreate(location);
      if (!locParsed.ok) {
        res.status(400).json({ success: false, error: locParsed.error });
        return;
      }
      legacyLocation = locParsed.value;
    }

    // Atomic operation: Update role + Create creator profile (using transaction)
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      let assignedAgencyId: mongoose.Types.ObjectId | undefined;
      if (targetUser.referredBy) {
        const refUser = await User.findById(targetUser.referredBy).select('role').session(session).lean();
        if (refUser && isAgencyRole(refUser.role)) {
          assignedAgencyId = targetUser.referredBy as mongoose.Types.ObjectId;
        }
      }

      let createdCreator;

      if (hasLegacyProfile) {
        // Update user role within transaction
        targetUser.role = 'creator';

        const previousCoins = targetUser.coins || 0;
        targetUser.coins = 0;
        targetUser.hostOnboardingStatus = 'none';

        if (previousCoins > 0) {
          console.log(
            `💰 [USER] Removed ${previousCoins} coins from user ${targetUser._id} (promoted to creator, coins set to 0)`
          );
        }

        await targetUser.save({ session });
        await ensureCreatorPromotionBonusReversalEntry(targetUser, session);

        const creator = await Creator.create(
          [
            {
              name,
              about,
              photo,
              userId: targetUser._id,
              ...(targetUser.firebaseUid ? { firebaseUid: targetUser.firebaseUid.trim() } : {}),
              categories: Array.isArray(categories) ? categories : [],
              price: validatedPrice as number,
              ...(assignedAgencyId ? { assignedAgencyId } : {}),
              ...(legacyLocation !== undefined ? { location: legacyLocation } : {}),
            },
          ],
          { session }
        );
        createdCreator = creator[0];
      } else {
        targetUser.hostOnboardingStatus = 'none';
        createdCreator = await promoteUserToCreatorWithStarterProfile(targetUser, {
          assignedAgencyId,
          session,
        });
      }

      // Commit transaction
      await session.commitTransaction();
      
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
            categories: createdCreator.categories,
            price: createdCreator.price,
            location: createdCreator.location,
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

    // Legacy plain-URL `avatar` field was dropped in Phase E; only
    // avatarUploadSessionId / avatarPresetImageId are now honored.
    const {
      gender,
      age,
      username,
      avatarUploadSessionId,
      avatarPresetImageId,
      categories,
    } = req.body;

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

    // Update age
    if (age !== undefined) {
      if (age === null) {
        if (user.age !== undefined) {
          user.age = undefined;
          updated = true;
        }
      } else {
        const parsedAge = typeof age === 'string' ? parseInt(age, 10) : age;
        if (!Number.isInteger(parsedAge) || parsedAge < 13 || parsedAge > 120) {
          res.status(400).json({
            success: false,
            error: 'Age must be an integer between 13 and 120',
          });
          return;
        }
        if (user.age !== parsedAge) {
          user.age = parsedAge;
          updated = true;
        }
      }
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

    // ── Update avatar via direct-upload session (Cloudflare-Images) ────────
    if (typeof avatarUploadSessionId === 'string' && avatarUploadSessionId.trim().length > 0) {
      if (!isCloudflareImagesEnabled()) {
        res.status(503).json({
          success: false,
          code: 'IMAGES_DISABLED',
          error: 'Cloudflare Images is not enabled on this deployment',
        });
        return;
      }
      try {
        const { asset } = await commitImageAsset({
          sessionId: avatarUploadSessionId.trim(),
          userId: user._id.toString(),
          userObjectId: user._id,
          purpose: 'user-avatar',
          quotaScope: 'avatar',
          blurhashTarget: {
            kind: 'user-avatar',
            userId: user._id.toString(),
          },
        });
        // Preserve prior avatar so a moderation rejection can roll back.
        if (user.avatar) {
          user.previousAvatar = user.avatar;
        }
        user.avatar = asset;
        updated = true;
      } catch (commitError) {
        if (commitError instanceof CommitImageAssetError) {
          res.status(commitError.status).json({
            success: false,
            code: commitError.code,
            error: commitError.message,
          });
          return;
        }
        if (commitError instanceof CloudflareImagesCircuitOpenError) {
          setDegradedHeader(res);
          res.status(503).json({
            success: false,
            code: 'CLOUDFLARE_IMAGES_UNAVAILABLE',
            error: 'image service is temporarily unavailable; please retry',
          });
          return;
        }
        if (commitError instanceof CloudflareImagesError) {
          logError('User profile: Cloudflare Images error on avatar commit', commitError);
          res.status(commitError.status >= 500 ? 502 : commitError.status).json({
            success: false,
            code: 'CLOUDFLARE_IMAGES_ERROR',
            error: safeCloudflareImagesClientError(commitError.status),
          });
          return;
        }
        throw commitError;
      }
    } else if (typeof avatarPresetImageId === 'string' && avatarPresetImageId.trim().length > 0) {
      // Preset selection — no upload, just point at an existing Cloudflare imageId.
      user.avatar = makeImageAssetDoc({
        imageId: avatarPresetImageId.trim(),
        uploadedBy: user._id,
        moderationStatus: 'approved',
      });
      updated = true;
    }
    // Legacy `avatar: <URL string>` body branch was removed in Phase E.
    // Clients MUST now go through direct-upload + commit OR preset selection.

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
      try {
        const streamPayload = await getStreamUpsertPayload(user);
        await ensureStreamUser(user.firebaseUid, streamPayload);
        await invalidateOtherMemberCacheForFirebaseUid(user.firebaseUid);
      } catch (syncErr) {
        console.error('⚠️ [USER] Stream/cache sync after profile update failed:', syncErr);
      }
    }

    const userImages = serializeUserImages(user);
    res.json({
      success: true,
      data: {
        user: {
          id: user._id.toString(),
          email: user.email,
          phone: user.phone,
          gender: user.gender,
          age: user.age,
          username: user.username,
          // Cloudflare-Images shape (preferred by Flutter)
          avatarAsset: userImages.avatar,
          // Legacy shape — either a Firebase URL string or the raw IImageAsset doc
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

    if (isNonConsumerCoinsRole(user.role)) {
      res.status(403).json({
        success: false,
        error: 'Creators, admins, and agents cannot add coins through this endpoint',
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
    if (user.role === 'creator' || isSuperAdminRole(user.role)) {
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

function callHistoryOidString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return String(v);
}

function callHistoryToIsoString(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return undefined;
}

/** Stable wire shape for mobile: string IDs and ISO date strings only. */
function serializeCallHistoryForApi(entry: Record<string, unknown>): Record<string, unknown> {
  const e: Record<string, unknown> = { ...entry };
  if (e._id != null) e._id = callHistoryOidString(e._id);
  if (e.ownerUserId != null) e.ownerUserId = callHistoryOidString(e.ownerUserId);
  if (e.otherUserId != null) e.otherUserId = callHistoryOidString(e.otherUserId);
  if (e.otherCreatorId != null && e.otherCreatorId !== undefined) {
    e.otherCreatorId = callHistoryOidString(e.otherCreatorId);
  }
  e.createdAt = callHistoryToIsoString(e.createdAt) ?? new Date().toISOString();
  const updatedAt = callHistoryToIsoString(e.updatedAt);
  if (updatedAt !== undefined) e.updatedAt = updatedAt;
  const ratedAt = callHistoryToIsoString(e.ratedAt);
  if (ratedAt !== undefined) e.ratedAt = ratedAt;
  if (e.otherAvatar != null && typeof e.otherAvatar !== 'string') {
    delete e.otherAvatar;
  }
  return e;
}

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

    const otherUserIds = [...new Set(calls.map((c) => c.otherUserId.toString()))];

    let enrichedCalls = calls;
    if (otherUserIds.length > 0) {
      const objectIds = otherUserIds.map((id) => new mongoose.Types.ObjectId(id));
      const otherUsers = await User.find({ _id: { $in: objectIds } })
        .select('role username email phone avatar')
        .lean();

      const creatorUserIds = otherUsers
        .filter((u) => u.role === 'creator' || isSuperAdminRole(u.role))
        .map((u) => u._id);
      const creators =
        creatorUserIds.length > 0
          ? await Creator.find({ userId: { $in: creatorUserIds } })
              .select('userId name avatar')
              .lean()
          : [];

      // Post Phase E: chat presentation reads avatar from the canonical
      // `IImageAsset` on Creator (legacy `photo` string was removed).
      const creatorByUserId = new Map<string, { name?: string; avatar?: typeof creators[number]['avatar'] }>();
      for (const c of creators) {
        creatorByUserId.set(c.userId.toString(), {
          name: c.name,
          avatar: c.avatar ?? null,
        });
      }

      const presentationByUserId = new Map<
        string,
        ReturnType<typeof resolveChatPresentationFromDocs>
      >();
      for (const u of otherUsers) {
        const uid = u._id.toString();
        const cr =
          u.role === 'creator' || isSuperAdminRole(u.role)
            ? (creatorByUserId.get(uid) ?? null)
            : null;
        presentationByUserId.set(uid, resolveChatPresentationFromDocs(u, cr));
      }

      enrichedCalls = calls.map((c) => {
        const pres = presentationByUserId.get(c.otherUserId.toString());
        if (!pres) return c;
        return {
          ...c,
          otherName: pres.name,
          otherAvatar: pres.image,
          otherAvatarAsset: pres.avatarAsset ?? null,
        };
      });
    }

    res.json({
      success: true,
      data: {
        calls: enrichedCalls.map((c) => serializeCallHistoryForApi(c as Record<string, unknown>)),
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
