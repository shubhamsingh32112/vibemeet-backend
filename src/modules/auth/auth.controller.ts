import type { Request } from 'express';
import { Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
// Bonus program removed.
import { checkDeletedStatus } from '../user/deleted-identity.service';
import {
  assignReferralCodeToUser,
  applyReferralCode,
  type ApplyReferralCodeErrorCode,
} from '../user/referral.service';
import { isValidReferralCodeFormat } from '../../utils/referral-code';
import { referralUserFacingMessage } from '../../utils/referral-messages';
import { logInfo, logError, logDebug, logWarning } from '../../utils/logger';
import { getCreatorApplicationFlagsForUser } from '../agent/creator-application-status.service';
import { WELCOME_INTRO_CALL_CREDITS } from '../../config/pricing.config';
import { getDefaultPresetImageId } from '../images/preset-image-ids';
import { makeImageAssetDoc } from '../images/image-asset.schema';
import { serializeCreatorGallery } from '../images/creator-image-helpers';

const DEFAULT_NEW_USER_AGE = 26;
const DEFAULT_NEW_USER_GENDER = 'male' as const;
const DEFAULT_USER_CATEGORY_POOL = [
  'Trauma',
  'Health',
  'Breakup',
  'Low confidence',
  'Loneliness',
  'Stress',
  'Work',
  'Family',
  'Relationship',
];

function buildRandomUsername(): string {
  const suffix = Math.random().toString(36).slice(2, 9);
  return `u${suffix}`.slice(0, 10);
}

function welcomeFreeCallEligibleForUser(user: {
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

function pickRandomCategories(): string[] {
  const shuffled = [...DEFAULT_USER_CATEGORY_POOL].sort(() => Math.random() - 0.5);
  const count = Math.floor(Math.random() * 3) + 1;
  return shuffled.slice(0, count);
}

function buildDefaultFirstLoginProfile() {
  const defaultImageId = getDefaultPresetImageId();
  if (!defaultImageId) {
    logWarning(
      'No default preset Cloudflare imageId available — new user will be created without an avatar',
    );
  }
  return {
    gender: DEFAULT_NEW_USER_GENDER,
    age: DEFAULT_NEW_USER_AGE,
    username: buildRandomUsername(),
    avatar: defaultImageId
      ? makeImageAssetDoc({
          imageId: defaultImageId,
          uploadedBy: null,
          moderationStatus: 'approved',
        })
      : null,
    categories: pickRandomCategories(),
  };
}

function referralApplyFailure(code: ApplyReferralCodeErrorCode) {
  return {
    ok: false as const,
    code,
    message: referralUserFacingMessage(code),
  };
}

export const login = async (req: Request, res: Response): Promise<void> => {
  const startedAt = Date.now();
  let createdNow = false;
  let referralApply: { ok: true } | ReturnType<typeof referralApplyFailure> | undefined;
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

    const deletedStatus = await checkDeletedStatus({
      email: req.auth.email ?? null,
      phone: req.auth.phone ?? null,
    });
    const showWelcomeBackDialog = deletedStatus.isDeleted;

    let user = await User.findOne({ firebaseUid });

      // ✅ Create user ONLY here (never in middleware)
      if (!user) {
        createdNow = true;
        logInfo('Creating new user (first login)', { firebaseUid });
        const firstLoginProfile = buildDefaultFirstLoginProfile();

        const grantWelcomeIntro = !showWelcomeBackDialog;
        user = await User.create({
          firebaseUid: req.auth.firebaseUid,
          phone: req.auth.phone,
          email: req.auth.email,
          role: 'user', // Default to 'user' - creators are promoted later via admin or referral
          gender: firstLoginProfile.gender,
          age: firstLoginProfile.age,
          username: firstLoginProfile.username,
          avatar: firstLoginProfile.avatar,
          categories: firstLoginProfile.categories,
          coins: 0,
          introFreeCallCredits: grantWelcomeIntro ? WELCOME_INTRO_CALL_CREDITS : 0,
          welcomeFreeCallConsumedAt: grantWelcomeIntro ? null : new Date(),
          freeTextUsed: 0, // Legacy field; chat free quota is per creator in ChatMessageQuota
          onboardingStage: 'welcome',
          onboardingWelcomeSeenAt: null,
          onboardingBonusSeenAt: null,
          onboardingPermissionSeenAt: null,
          onboardingCompletedAt: null,
          permissionsIntroAcceptedAt: null,
          cameraMicPermissionStatus: 'unknown',
          notificationPermissionStatus: 'unknown',
          permissionsLastCheckedAt: null,
          lastPermissionsDecisionRequestId: null,
          lastOnboardingStageIdempotencyKey: null,
          permissionOnboardingStatus: 'unknown',
        });

        // Referral: assign unique code and apply referral if provided
        await assignReferralCodeToUser(user);
        const referralCodeRaw = typeof req.body?.referralCode === 'string' ? req.body.referralCode.trim() : null;
        if (referralCodeRaw) {
          if (!isValidReferralCodeFormat(referralCodeRaw)) {
            referralApply = referralApplyFailure('INVALID_FORMAT');
          } else {
            const ar = await applyReferralCode(user, referralCodeRaw, { mode: 'signup' });
            referralApply = ar.ok ? { ok: true } : referralApplyFailure(ar.code);
          }
        }
        user = (await User.findOne({ firebaseUid }))!;

        logInfo('New user created', {
          userId: user._id.toString(),
          firebaseUid,
          initialCoins: 0,
          introFreeCallCredits: user.introFreeCallCredits,
          grantWelcomeIntro,
          freeTextUsed: 0,
          gender: firstLoginProfile.gender,
          age: firstLoginProfile.age,
          username: firstLoginProfile.username,
          categories: firstLoginProfile.categories,
          showWelcomeBackDialog,
        });
    } else {
      // Keep older users smooth: backfill profile defaults if onboarding fields are missing.
      const existingDefaults = buildDefaultFirstLoginProfile();
      let profileBackfilled = false;
      if (user.role === 'user') {
        if (!user.gender) {
          user.gender = existingDefaults.gender;
          profileBackfilled = true;
        }
        if (!Number.isInteger(user.age)) {
          user.age = existingDefaults.age;
          profileBackfilled = true;
        }
        if (!user.username || user.username.trim().length === 0) {
          user.username = existingDefaults.username;
          profileBackfilled = true;
        }
        // Backfill avatar with the default preset only when the user has
        // none. Legacy string-URL avatars were normalized out in Phase E.
        if (user.avatar == null) {
          user.avatar = existingDefaults.avatar;
          profileBackfilled = true;
        }
        if (!Array.isArray(user.categories) || user.categories.length === 0) {
          user.categories = existingDefaults.categories;
          profileBackfilled = true;
        }
        if (!user.cameraMicPermissionStatus) {
          user.cameraMicPermissionStatus = 'unknown';
          profileBackfilled = true;
        }
        if (!user.notificationPermissionStatus) {
          user.notificationPermissionStatus = 'unknown';
          profileBackfilled = true;
        }
        if (typeof user.lastPermissionsDecisionRequestId === 'undefined') {
          user.lastPermissionsDecisionRequestId = null;
          profileBackfilled = true;
        }
        if (typeof user.lastOnboardingStageIdempotencyKey === 'undefined') {
          user.lastOnboardingStageIdempotencyKey = null;
          profileBackfilled = true;
        }
        if (!user.permissionOnboardingStatus) {
          user.permissionOnboardingStatus = 'unknown';
          profileBackfilled = true;
        }
      }

      // Keep user contact info in sync (DB writes are OK here)
      const needsContactUpdate =
        (req.auth.email && user.email !== req.auth.email) ||
        (req.auth.phone && user.phone !== req.auth.phone);

      if (needsContactUpdate || profileBackfilled) {
        if (req.auth.email) user.email = req.auth.email;
        if (req.auth.phone) user.phone = req.auth.phone;
        await user.save();
        if (profileBackfilled) {
          logInfo('Backfilled existing user onboarding defaults', {
            userId: user._id.toString(),
            firebaseUid,
          });
        } else {
          logDebug('User contact info updated', { userId: user._id.toString() });
        }
      }

      // Referral: existing account attach must respect late-attach constraints.
      const existingReferralRaw =
        typeof req.body?.referralCode === 'string' ? req.body.referralCode.trim() : '';
      if (existingReferralRaw) {
        if (user.referredBy) {
          referralApply = referralApplyFailure('ALREADY_REFERRED');
        } else {
          if (!user.referralCode) {
            await assignReferralCodeToUser(user);
          }
          const working = await User.findOne({ firebaseUid });
          if (working) user = working;

          if (!isValidReferralCodeFormat(existingReferralRaw)) {
            referralApply = referralApplyFailure('INVALID_FORMAT');
          } else {
            const ar = await applyReferralCode(user, existingReferralRaw, { mode: 'late_attach' });
            referralApply = ar.ok ? { ok: true } : referralApplyFailure(ar.code);
            const latest = await User.findOne({ firebaseUid });
            if (latest) user = latest;
          }
        }
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
    const creator = await Creator.findOne({ userId: user._id }).lean();

    const needsOnboarding = (user.categories ?? []).length === 0;
    const onboardingState = {
      stage: user.onboardingStage === 'permissions' ? 'permission' : (user.onboardingStage ?? 'welcome'),
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
    if (createdNow && user.role !== 'user') {
      logError('New user created with invalid role', new Error('invalid_role_on_create'), {
        firebaseUid,
        role: user.role,
        userId: user._id.toString(),
      });
    }
    logInfo('Onboarding gate decision', {
      firebaseUid,
      userId: user._id.toString(),
      role: user.role,
      createdNow,
      stage: onboardingState.stage,
      showWelcomeBackDialog,
    });
    const appFlags = await getCreatorApplicationFlagsForUser(user._id);

    // If creator exists, return creator details as primary data
    if (creator) {
      res.json({
        success: true,
        data: {
          // Primary data from creator collection
          id: creator._id.toString(),
          name: creator.name,
          about: creator.about,
          galleryImages: serializeCreatorGallery(creator.galleryImages || []),
          email: user.email, // Use user's email (identity comes from user)
          phone: user.phone, // Use user's phone (identity comes from user)
          categories: creator.categories,
          price: creator.price,
          age: creator.age,
          location: creator.location,
          // User-specific data (coins, role, etc.)
          coins: user.coins,
          introFreeCallCredits: Number(user.introFreeCallCredits) || 0,
          welcomeFreeCallEligible: welcomeFreeCallEligibleForUser(user),
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
          createdNow,
          onboarding: onboardingState,
          referralCode: user.referralCode ?? undefined,
          profileRevision: user.profileRevision ?? 0,
          creatorApplicationPending: appFlags.creatorApplicationPending,
          creatorApplicationRejected: appFlags.creatorApplicationRejected,
          ...(appFlags.creatorApplicationRejectionReason
            ? { creatorApplicationRejectionReason: appFlags.creatorApplicationRejectionReason }
            : {}),
          ...(referralApply !== undefined ? { referralApply } : {}),
          meta: {
            showWelcomeBackDialog,
          },
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
            age: user.age,
            username: user.username,
            avatar: user.avatar,
            categories: user.categories,
            usernameChangeCount: user.usernameChangeCount,
            coins: user.coins,
            introFreeCallCredits: Number(user.introFreeCallCredits) || 0,
            welcomeFreeCallEligible: welcomeFreeCallEligibleForUser(user),
            role: user.role,
            referralCode: user.referralCode ?? undefined,
            profileRevision: user.profileRevision ?? 0,
            creatorApplicationPending: appFlags.creatorApplicationPending,
            creatorApplicationRejected: appFlags.creatorApplicationRejected,
            onboarding: onboardingState,
            ...(appFlags.creatorApplicationRejectionReason
              ? { creatorApplicationRejectionReason: appFlags.creatorApplicationRejectionReason }
              : {}),
          },
          creator: null,
          needsOnboarding,
          createdNow,
          ...(referralApply !== undefined ? { referralApply } : {}),
          meta: {
            showWelcomeBackDialog,
          },
        },
      });
    }

    logDebug('Login request completed', {
      firebaseUid,
      durationMs: Date.now() - startedAt,
      role: user.role,
      hasCreatorProfile: !!creator,
      needsOnboarding,
    });
  } catch (error) {
    logError('Login error', error, {
      firebaseUid: req.auth?.firebaseUid,
      ip: req.ip,
      durationMs: Date.now() - startedAt,
    });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

/**
 * Lightweight precheck endpoint for phone OTP starts.
 * Actual OTP send remains client-driven via Firebase verifyPhoneNumber.
 */
export const phonePrecheck = async (_req: Request, res: Response): Promise<void> => {
  res.json({
    success: true,
    data: { allowed: true },
  });
};

/**
 * Fast Login was removed. Old app builds still call this route — return 410 so clients
 * can show a clear message instead of treating the response as success.
 */
export const fastLoginDeprecated = (_req: Request, res: Response): void => {
  res.status(410).json({
    success: false,
    error:
      'Fast login is no longer supported. Please update the app and sign in with Google or phone.',
  });
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

/**
 * Agent dashboard login — email + bcrypt password on User (role agent).
 */
export const agentLogin = async (req: Request, res: Response): Promise<void> => {
  try {
    const email = String(req.body.email ?? '')
      .trim()
      .toLowerCase();
    const password = String(req.body.password ?? '');

    if (!email || !password) {
      res.status(400).json({ success: false, error: 'Email and password are required' });
      return;
    }

    const jwtSecret = (process.env.JWT_SECRET || 'admin-secret-change-me').trim();
    const user = await User.findOne({ email, role: 'agent' }).select('+passwordHash');

    if (!user || !user.passwordHash || user.agentDisabled) {
      logInfo('Agent login failed', { email, ip: req.ip });
      res.status(401).json({ success: false, error: 'Invalid email or password' });
      return;
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      logInfo('Agent login failed: bad password', { email, ip: req.ip });
      res.status(401).json({ success: false, error: 'Invalid email or password' });
      return;
    }

    const token = jwt.sign(
      { userId: user._id.toString(), role: 'agent', email: user.email },
      jwtSecret,
      { expiresIn: '7d' },
    );

    logInfo('Agent login successful', { userId: user._id.toString(), ip: req.ip });

    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user._id.toString(),
          email: user.email,
          role: user.role,
          displayName: user.displayName ?? null,
          referralCode: user.referralCode ?? null,
        },
      },
    });
  } catch (error) {
    logError('Agent login error', error, { ip: req.ip });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
