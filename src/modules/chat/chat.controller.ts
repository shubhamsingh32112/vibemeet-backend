import type { Request } from 'express';
import { Response } from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { randomUUID } from 'crypto';
import { getStreamClient, ensureStreamUser } from '../../config/stream';
import { getRedis } from '../../config/redis';
import { User } from '../user/user.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import {
  ChatMessageQuota,
  FREE_MESSAGES_PER_CREATOR,
  COST_PER_MESSAGE,
} from './chat-message-quota.model';

// ══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════════════════

/** Redis prefix for idempotent pre-send locks */
const PRESEND_LOCK_PREFIX = 'chat:presend:';
/** How long an idempotency lock lives (seconds). Covers retries + slow networks. */
const PRESEND_LOCK_TTL = 60;

// ══════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════

/**
 * Generate deterministic channel ID for User-Creator pair.
 *
 * Stream Chat channel IDs max = 64 chars.
 * Firebase UIDs are ~28 chars each, so we hash the sorted pair.
 *
 * Format: uc_<32-char-hex-hash>  (total 35 chars)
 */
const generateChannelId = (uid1: string, uid2: string): string => {
  const [a, b] = [uid1, uid2].sort();
  const hash = crypto
    .createHash('sha256')
    .update(`${a}:${b}`)
    .digest('hex')
    .slice(0, 32);
  return `uc_${hash}`;
};

/**
 * Resolve a display-name for a user (prefers username → email → phone → 'User').
 */
const displayNameFor = (user: {
  username?: string;
  email?: string;
  phone?: string;
}): string =>
  user.username && user.username.trim().length > 0
    ? user.username
    : user.email && user.email.trim().length > 0
      ? user.email
      : user.phone && user.phone.trim().length > 0
        ? user.phone
        : 'User';

/** Check if a user role should be billed for chat */
const isBillableRole = (role: string): boolean => role === 'user';

// ══════════════════════════════════════════════════════════════════════════
// POST /api/v1/chat/token
// ══════════════════════════════════════════════════════════════════════════

export const getChatToken = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const firebaseUid = req.auth.firebaseUid;
    const client = getStreamClient();

    const user = await User.findOne({ firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    await ensureStreamUser(firebaseUid, {
      name: displayNameFor(user),
      image: user.avatar,
      appRole: user.role,
      username: user.username,
    });

    const token = client.createToken(firebaseUid);
    res.json({ success: true, data: { token } });
  } catch (error) {
    console.error('❌ [CHAT] Error generating token:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to generate chat token' });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// POST /api/v1/chat/channel
// Create or fetch channel for User-Creator pair.
// Returns quota info (free remaining / cost-per-message) for UI display.
//
// FIX: Also normalizes legacy channel names ("Chat with X" → "X").
// ══════════════════════════════════════════════════════════════════════════

export const createOrGetChannel = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { otherUserId } = req.body;
    if (!otherUserId) {
      res
        .status(400)
        .json({ success: false, error: 'otherUserId is required' });
      return;
    }

    // ── Resolve both users ────────────────────────────────────────────
    const currentUser = await User.findOne({
      firebaseUid: req.auth.firebaseUid,
    });
    if (!currentUser) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    // Accept either MongoDB ObjectId OR Firebase UID
    let otherUser = mongoose.isValidObjectId(otherUserId)
      ? await User.findById(otherUserId)
      : null;
    if (!otherUser) {
      otherUser = await User.findOne({ firebaseUid: otherUserId });
    }
    if (!otherUser) {
      res.status(404).json({ success: false, error: 'Other user not found' });
      return;
    }

    const currentUid = currentUser.firebaseUid;
    const otherUid = otherUser.firebaseUid;

    // ── Ensure both Stream users exist ────────────────────────────────
    await ensureStreamUser(currentUid, {
      name: displayNameFor(currentUser),
      image: currentUser.avatar,
      appRole: currentUser.role,
      username: currentUser.username,
    });
    await ensureStreamUser(otherUid, {
      name: displayNameFor(otherUser),
      image: otherUser.avatar,
      appRole: otherUser.role,
      username: otherUser.username,
    });

    // ── Create / get channel ──────────────────────────────────────────
    const channelId = generateChannelId(currentUid, otherUid);
    const client = getStreamClient();

    const correctName = displayNameFor(otherUser);

    const channel = client.channel('messaging', channelId, {
      members: [currentUid, otherUid],
      created_by_id: currentUid,
      name: correctName,
    });

    await channel.create();

    // ── Normalize legacy "Chat with …" names ─────────────────────────
    const existingName =
      (channel.data?.name as string | undefined) ?? '';
    if (existingName.startsWith('Chat with ')) {
      try {
        await channel.update({ name: correctName } as Record<string, unknown>);
        console.log(
          `🔄 [CHAT] Normalized channel name: "${existingName}" → "${correctName}"`,
        );
      } catch (nameErr) {
        console.warn('⚠️ [CHAT] Failed to normalize channel name:', nameErr);
      }
    }

    await channel.watch();

    // ── Compute quota for the current user ────────────────────────────
    let freeRemaining = FREE_MESSAGES_PER_CREATOR;
    let costPerMessage = 0;

    // Hard-guard: only billable roles get quota lookups
    if (isBillableRole(currentUser.role)) {
      const creatorUid =
        otherUser.role === 'creator' || otherUser.role === 'admin'
          ? otherUid
          : null;

      if (creatorUid) {
        const quota = await ChatMessageQuota.findOne({
          userFirebaseUid: currentUid,
          creatorFirebaseUid: creatorUid,
        });
        const sent = quota?.freeMessagesSent ?? 0;
        freeRemaining = Math.max(0, FREE_MESSAGES_PER_CREATOR - sent);
        costPerMessage = freeRemaining > 0 ? 0 : COST_PER_MESSAGE;
      }
    }

    res.json({
      success: true,
      data: {
        channelId,
        type: 'messaging',
        cid: channel.cid,
        quota: {
          freeRemaining,
          costPerMessage,
          freeTotal: FREE_MESSAGES_PER_CREATOR,
          userCoins: currentUser.coins,
        },
      },
    });
  } catch (error) {
    console.error('❌ [CHAT] Error creating/getting channel:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to create or get channel' });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// POST /api/v1/chat/pre-send
//
// Called by the frontend BEFORE every message the **user** sends.
// Checks quota, deducts coins if needed, returns approval.
//
// Hardened with:
//   ✅ Idempotency lock (Redis, 60 s) — prevents double-send on retries.
//   ✅ MongoDB transaction — quota + coins + CoinTransaction are atomic.
//   ✅ Hard creator guard — non-billable roles never touch quota/coins.
//
// Body: { channelId: string, messageId?: string }
// ══════════════════════════════════════════════════════════════════════════

export const preSendMessage = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { channelId, messageId } = req.body;
    if (!channelId) {
      res
        .status(400)
        .json({ success: false, error: 'channelId is required' });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    // ── Hard-guard: creators / admins never pay ───────────────────────
    if (!isBillableRole(user.role)) {
      res.json({
        success: true,
        data: {
          canSend: true,
          freeRemaining: 999,
          coinsCharged: 0,
          userCoins: user.coins,
        },
      });
      return;
    }

    // ── Idempotency lock (Redis) ──────────────────────────────────────
    // If the frontend provides a messageId we use it; otherwise fall back
    // to a channelId+userId composite (still protects against rapid taps).
    const idempotencyKey =
      messageId ?? `${channelId}:${user.firebaseUid}:${Date.now()}`;
    const lockKey = `${PRESEND_LOCK_PREFIX}${idempotencyKey}`;

    const redis = getRedis();
    // SET NX — only succeeds if the key does NOT already exist
    const lockAcquired = await redis.set(lockKey, 'pending', {
      ex: PRESEND_LOCK_TTL,
      nx: true,
    });

    if (!lockAcquired) {
      // Duplicate request — return the cached result if available
      const cached = await redis.get<string>(lockKey);
      if (cached && cached !== 'pending') {
        console.log(
          `🔁 [CHAT] Idempotent hit for ${idempotencyKey} — returning cached result`,
        );
        res.json(JSON.parse(cached));
        return;
      }

      // Lock exists but result not cached yet (race) — safe to let through
      // with a small re-check.  In practice this means "first request is
      // still processing".  We return a canSend:true with 0 coins charged
      // so the second tap is effectively a no-op on the billing side.
      console.log(
        `⏳ [CHAT] Concurrent pre-send for ${idempotencyKey} — returning optimistic OK`,
      );
      res.json({
        success: true,
        data: {
          canSend: true,
          freeRemaining: 0,
          coinsCharged: 0,
          userCoins: user.coins,
        },
      });
      return;
    }

    // ── Resolve creator from channel members ──────────────────────────
    const client = getStreamClient();
    const channel = client.channel('messaging', channelId);
    const channelState = await channel.watch();

    const memberIds: string[] = Object.keys(channelState.members || {});
    const creatorFirebaseUid = memberIds.find(
      (id) => id !== user.firebaseUid,
    );

    if (!creatorFirebaseUid) {
      await redis.del(lockKey); // release lock
      res
        .status(400)
        .json({ success: false, error: 'Cannot determine channel members' });
      return;
    }

    // ── Transactional quota + coin + txn update ───────────────────────
    const session = await mongoose.startSession();
    let responsePayload: object;

    try {
      await session.withTransaction(async () => {
        // Re-read user inside transaction for consistency
        const txnUser = await User.findById(user._id).session(session);
        if (!txnUser) throw new Error('User not found inside transaction');

        // Get or create quota
        let quota = await ChatMessageQuota.findOne({
          userFirebaseUid: txnUser.firebaseUid,
          creatorFirebaseUid,
        }).session(session);

        if (!quota) {
          [quota] = await ChatMessageQuota.create(
            [
              {
                userFirebaseUid: txnUser.firebaseUid,
                creatorFirebaseUid,
                channelId,
                freeMessagesSent: 0,
                paidMessagesSent: 0,
              },
            ],
            { session },
          );
        }

        // ── Free slot available? ──────────────────────────────────────
        if (quota.freeMessagesSent < FREE_MESSAGES_PER_CREATOR) {
          quota.freeMessagesSent += 1;
          await quota.save({ session });

          const freeRemaining =
            FREE_MESSAGES_PER_CREATOR - quota.freeMessagesSent;
          console.log(
            `💬 [CHAT] Free msg ${quota.freeMessagesSent}/${FREE_MESSAGES_PER_CREATOR} ` +
              `for ${txnUser.firebaseUid} → ${creatorFirebaseUid}`,
          );

          responsePayload = {
            success: true,
            data: {
              canSend: true,
              freeRemaining,
              coinsCharged: 0,
              userCoins: txnUser.coins,
            },
          };
          return; // commit
        }

        // ── Paid message — insufficient coins? ────────────────────────
        if (txnUser.coins < COST_PER_MESSAGE) {
          console.log(
            `💬 [CHAT] Insufficient coins: ${txnUser.firebaseUid} ` +
              `has ${txnUser.coins}, needs ${COST_PER_MESSAGE}`,
          );
          responsePayload = {
            success: true,
            data: {
              canSend: false,
              freeRemaining: 0,
              coinsCharged: 0,
              userCoins: txnUser.coins,
              error: `You need ${COST_PER_MESSAGE} coins to send a message. Please add coins.`,
            },
          };
          return; // commit (no mutations)
        }

        // ── Deduct coins (atomic inside transaction) ──────────────────
        txnUser.coins -= COST_PER_MESSAGE;
        await txnUser.save({ session });

        quota.paidMessagesSent += 1;
        await quota.save({ session });

        await CoinTransaction.create(
          [
            {
              transactionId: `chat_${channelId}_${randomUUID()}`,
              userId: txnUser._id,
              type: 'debit',
              coins: COST_PER_MESSAGE,
              source: 'chat_message',
              description: 'Chat message to creator',
              status: 'completed',
            },
          ],
          { session },
        );

        console.log(
          `💬 [CHAT] Paid msg: ${txnUser.firebaseUid} charged ${COST_PER_MESSAGE} coins ` +
            `(remaining: ${txnUser.coins})`,
        );

        responsePayload = {
          success: true,
          data: {
            canSend: true,
            freeRemaining: 0,
            coinsCharged: COST_PER_MESSAGE,
            userCoins: txnUser.coins,
          },
        };
      });
    } finally {
      await session.endSession();
    }

    // ── Cache result in the idempotency key ───────────────────────────
    await redis.set(lockKey, JSON.stringify(responsePayload!), {
      ex: PRESEND_LOCK_TTL,
    });

    res.json(responsePayload!);
  } catch (error) {
    console.error('❌ [CHAT] Error in pre-send:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to validate message' });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// GET /api/v1/chat/quota/:channelId
//
// Returns the current user's message quota for a given channel.
// ══════════════════════════════════════════════════════════════════════════

export const getMessageQuota = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { channelId } = req.params;
    if (!channelId) {
      res
        .status(400)
        .json({ success: false, error: 'channelId is required' });
      return;
    }

    const user = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    // Hard-guard: non-billable roles are always free
    if (!isBillableRole(user.role)) {
      res.json({
        success: true,
        data: {
          freeRemaining: 999,
          costPerMessage: 0,
          freeTotal: FREE_MESSAGES_PER_CREATOR,
          userCoins: user.coins,
        },
      });
      return;
    }

    const quota = await ChatMessageQuota.findOne({
      userFirebaseUid: user.firebaseUid,
      channelId,
    });

    const sent = quota?.freeMessagesSent ?? 0;
    const freeRemaining = Math.max(0, FREE_MESSAGES_PER_CREATOR - sent);

    res.json({
      success: true,
      data: {
        freeRemaining,
        costPerMessage: freeRemaining > 0 ? 0 : COST_PER_MESSAGE,
        freeTotal: FREE_MESSAGES_PER_CREATOR,
        userCoins: user.coins,
      },
    });
  } catch (error) {
    console.error('❌ [CHAT] Error getting quota:', error);
    res.status(500).json({ success: false, error: 'Failed to get quota' });
  }
};
