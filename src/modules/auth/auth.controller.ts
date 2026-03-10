import type { Request } from 'express';
import { Response } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { checkBonusEligibility } from '../user/identity.service';
import { assignReferralCodeToUser, applyReferralCode } from '../user/referral.service';
import { isValidReferralCodeFormat } from '../../utils/referral-code';
import { getFirebaseAdmin } from '../../config/firebase';
import { logInfo, logError, logDebug } from '../../utils/logger';

/** Max length for deviceFingerprint and installId in fast-login. */
const FAST_LOGIN_FINGERPRINT_MAX = 256;

export const login = async (req: Request, res: Response): Promise<void> => {
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

    let user = await User.findOne({ firebaseUid });

      // ✅ Create user ONLY here (never in middleware)
      if (!user) {
        logInfo('Creating new user (first login)', { firebaseUid });

        // Identity-based welcome bonus eligibility — pass ALL identities we know
        // (user may have signed in with Google before, then Fast Login; check all to prevent bypass)
        let deviceFingerprint: string | undefined;
        if (typeof req.body?.deviceFingerprint === 'string') {
          const fp = req.body.deviceFingerprint.trim();
          if (fp.length > 0 && fp.length <= FAST_LOGIN_FINGERPRINT_MAX) {
            deviceFingerprint = fp;
          }
        }
        const googleId = firebaseUid.startsWith('fast_') ? undefined : firebaseUid;
        const welcomeBonusEligible = await checkBonusEligibility({
          deviceFingerprint: deviceFingerprint ?? null,
          googleId: googleId ?? null,
          phone: req.auth.phone ?? null,
        });
        const welcomeBonusClaimed = !welcomeBonusEligible;

        // 🔥 CRITICAL: Only regular users can claim welcome bonus (not creators)
        // New users start with 0 coins - they get 30 free coins when they accept the welcome bonus popup
        // Creators don't need coins to receive calls/texts, so they don't get free coins
        user = await User.create({
          firebaseUid: req.auth.firebaseUid,
          phone: req.auth.phone,
          email: req.auth.email,
          role: 'user', // Default to 'user' - creators are promoted later via admin or referral
          categories: [], // onboarding pending
          coins: 0, // ✅ New users start with 0 coins - 30 coins are added when they accept the welcome bonus popup
          freeTextUsed: 0, // ✅ Initialize free text counter (3 free chats for new users)
          welcomeBonusClaimed: welcomeBonusClaimed, // ✅ Set to true if phone number previously claimed bonus
        });

        // Referral: assign unique code and apply referral if provided
        await assignReferralCodeToUser(user);
        const referralCodeRaw = typeof req.body?.referralCode === 'string' ? req.body.referralCode.trim() : null;
        if (referralCodeRaw && isValidReferralCodeFormat(referralCodeRaw)) {
          await applyReferralCode(user, referralCodeRaw);
          // Reload user in case role was promoted to creator
          await user.save();
        }

        logInfo('New user created', {
          userId: user._id.toString(),
          firebaseUid,
          initialCoins: 0,
          freeTextUsed: 0,
          welcomeBonusClaimed: welcomeBonusClaimed,
        });
    } else {
      // Keep user contact info in sync (DB writes are OK here)
      const needsUpdate =
        (req.auth.email && user.email !== req.auth.email) ||
        (req.auth.phone && user.phone !== req.auth.phone);

      if (needsUpdate) {
        if (req.auth.email) user.email = req.auth.email;
        if (req.auth.phone) user.phone = req.auth.phone;
        await user.save();
        logDebug('User contact info updated', { userId: user._id.toString() });
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
          age: creator.age,
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
          referralCode: user.referralCode ?? undefined,
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
            welcomeBonusClaimed: user.welcomeBonusClaimed,
            role: user.role,
            referralCode: user.referralCode ?? undefined,
          },
          creator: null,
          needsOnboarding,
        },
      });
    }
  } catch (error) {
    logError('Login error', error, {
      firebaseUid: req.auth?.firebaseUid,
      ip: req.ip,
    });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

/**
 * Fast Login — device-based auth (no Google).
 * Returns a Firebase custom token so the client can sign in with signInWithCustomToken.
 * User identity remains Firebase UID; Stream, sockets, calls unchanged.
 * Rate-limited by IP (see auth.routes).
 */
export const fastLogin = async (req: Request, res: Response): Promise<void> => {
  try {
    const deviceFingerprint = typeof req.body?.deviceFingerprint === 'string'
      ? req.body.deviceFingerprint.trim()
      : '';
    const installId = typeof req.body?.installId === 'string'
      ? req.body.installId.trim()
      : '';

    if (!deviceFingerprint || !installId) {
      res.status(400).json({
        success: false,
        error: 'deviceFingerprint and installId are required',
      });
      return;
    }
    if (deviceFingerprint.length > FAST_LOGIN_FINGERPRINT_MAX || installId.length > FAST_LOGIN_FINGERPRINT_MAX) {
      res.status(400).json({
        success: false,
        error: 'deviceFingerprint and installId must be at most 256 characters',
      });
      return;
    }

    logDebug('Fast login attempt', { ip: req.ip, hasFingerprint: true });

    // Compute deterministic UID once for both lookup and create
    const uidSalt = `${deviceFingerprint}:${installId}`;
    const hash = crypto.createHash('sha256').update(uidSalt).digest('hex').slice(0, 22);
    const firebaseUid = `fast_${hash}`;

    // Lookup by deviceFingerprint OR firebaseUid — single DB round trip, uses both indexes
    let user = await User.findOne({
      $or: [{ deviceFingerprint }, { firebaseUid }],
    });

    if (user) {
      // Existing Fast Login user — return custom token for their Firebase UID
      const admin = getFirebaseAdmin();
      const customToken = await admin.auth().createCustomToken(user.firebaseUid);
      logInfo('Fast login existing user', {
        userId: user._id.toString(),
        firebaseUid: user.firebaseUid,
        ip: req.ip,
      });
      res.json({
        success: true,
        data: { firebaseCustomToken: customToken },
      });
      return;
    }

    // New Fast Login user: firebaseUid already computed above
    const admin = getFirebaseAdmin();
    try {
      await admin.auth().getUser(firebaseUid);
    } catch {
      // User does not exist in Firebase — create custom user
      try {
        await admin.auth().createUser({
          uid: firebaseUid,
          displayName: 'Fast Login User',
        });
        logDebug('Firebase custom user created for fast login', { firebaseUid });
      } catch (createErr: unknown) {
        const code = (createErr as { code?: string })?.code;
        if (code === 'auth/uid-already-exists') {
          // Race: another concurrent request created Firebase user. Find Mongo user.
          user = await User.findOne({ $or: [{ firebaseUid }, { deviceFingerprint }] });
          if (user) {
            const customToken = await admin.auth().createCustomToken(user.firebaseUid);
            res.json({ success: true, data: { firebaseCustomToken: customToken } });
            return;
          }
        }
        throw createErr;
      }
    }

    // Identity-based welcome bonus eligibility (deviceFingerprint)
    const welcomeBonusEligible = await checkBonusEligibility({
      deviceFingerprint: deviceFingerprint,
    });
    const welcomeBonusClaimed = !welcomeBonusEligible;

    try {
      user = await User.create({
        firebaseUid,
        deviceFingerprint,
        installId,
        authProvider: 'fast',
        role: 'user',
        categories: [],
        coins: 0,
        freeTextUsed: 0,
        welcomeBonusClaimed,
      });

      // Referral: assign unique code and apply referral if provided
      await assignReferralCodeToUser(user);
      const referralCodeRaw = typeof req.body?.referralCode === 'string' ? req.body.referralCode.trim() : null;
      if (referralCodeRaw && isValidReferralCodeFormat(referralCodeRaw)) {
        await applyReferralCode(user, referralCodeRaw);
        await user.save();
      }
    } catch (mongoErr: unknown) {
      // E11000 duplicate key (race: another request just created user)
      const msg = String((mongoErr as Error)?.message ?? '');
      if (msg.includes('E11000') || msg.includes('duplicate key')) {
        user = await User.findOne({ $or: [{ firebaseUid }, { deviceFingerprint }] });
        if (user) {
          const customToken = await admin.auth().createCustomToken(user.firebaseUid);
          res.json({ success: true, data: { firebaseCustomToken: customToken } });
          return;
        }
      }
      throw mongoErr;
    }

    const customToken = await admin.auth().createCustomToken(firebaseUid);
    logInfo('Fast login new user created', {
      userId: user._id.toString(),
      firebaseUid,
      welcomeBonusClaimed,
      ip: req.ip,
    });

    res.json({
      success: true,
      data: { firebaseCustomToken: customToken },
    });
  } catch (error) {
    logError('Fast login error', error, { ip: req.ip });
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
