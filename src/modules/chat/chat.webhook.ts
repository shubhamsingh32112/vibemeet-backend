import type { Request, Response } from 'express';
import { User } from '../user/user.model';
import {
  ChatMessageQuota,
  FREE_MESSAGES_PER_CREATOR,
  COST_PER_MESSAGE,
} from './chat-message-quota.model';
import { normalizeQuotaForCurrentPeriod } from './chat-quota-period.util';
import { isVipActive } from '../vip/vip-entitlement.service';

/**
 * Stream Chat webhook handler.
 *
 * Acts as a **backup** enforcement layer.  The primary enforcement is the
 * `POST /api/v1/chat/pre-send` endpoint that the frontend calls before
 * every message.  This webhook catches edge-cases (e.g. bypassed clients).
 *
 * NOTE: For this to reject messages Stream must be configured in
 * "blocking webhook" mode.  In notification-only mode the message is
 * already delivered and this handler is purely observational.
 *
 * Endpoint: POST /api/v1/chat/webhook
 */

interface StreamWebhookPayload {
  type: string;
  message?: {
    id: string;
    text?: string;
    user?: {
      id: string;
      extraData?: {
        appRole?: string;
      };
    };
    attachments?: Array<{
      type: string;
      [key: string]: unknown;
    }>;
  };
  channel?: {
    id: string;
    type: string;
  };
}

const parseWebhookPayload = (body: unknown): StreamWebhookPayload => {
  if (Buffer.isBuffer(body)) {
    const raw = body.toString('utf8');
    return raw.trim() ? (JSON.parse(raw) as StreamWebhookPayload) : ({} as StreamWebhookPayload);
  }
  return (body || {}) as StreamWebhookPayload;
};

/**
 * Validate attachments — only creators can send images / videos.
 * Voice messages are allowed for everyone.
 */
const validateAttachments = async (
  attachments: Array<{ type: string; [key: string]: unknown }> | undefined,
  userId: string
): Promise<boolean> => {
  if (!attachments || attachments.length === 0) return true;

  const hasOnlyVoice = attachments.every(
    (att) => att.type === 'audio' || att.type === 'voice'
  );
  if (hasOnlyVoice) return true;

  try {
    const user = await User.findOne({ firebaseUid: userId });
    if (!user) return false;
    return user.role === 'creator' || user.role === 'admin';
  } catch {
    return false;
  }
};

export const handleStreamWebhook = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const payload = parseWebhookPayload(req.body);

    console.log(`📥 [WEBHOOK] Received: ${payload.type}`);

    if (payload.type === 'message.new' && payload.message) {
      const message = payload.message;
      const userId = message.user?.id;

      if (!userId) {
        res.status(400).json({ error: 'Missing user ID' });
        return;
      }

      // ── Attachment validation (images/videos only for creators) ────
      const attachmentsValid = await validateAttachments(
        message.attachments,
        userId
      );
      if (!attachmentsValid) {
        console.log(`❌ [WEBHOOK] Rejected: Attachments not allowed for user ${userId}`);
        res.status(403).json({
          error: 'Only creators can send media attachments.',
        });
        return;
      }

      // ── Quota / coin backup check (catches bypassed clients) ───────
      const user = await User.findOne({ firebaseUid: userId });
      if (user && user.role === 'user' && payload.channel?.id) {
        if (await isVipActive(user._id)) {
          res.status(200).json({ success: true });
          return;
        }

        const channelId = payload.channel.id;

        // Resolve creator UID from channel members
        // The channel members aren't in the webhook payload, so we look
        // up the quota record (if it exists).  If it doesn't exist this
        // is likely the very first message and pre-send already created
        // the record, so we trust it.
        const quota = await ChatMessageQuota.findOne({
          userFirebaseUid: userId,
          channelId,
        });

        if (quota) {
          await normalizeQuotaForCurrentPeriod(quota);
        }

        if (quota && quota.freeMessagesSent >= FREE_MESSAGES_PER_CREATOR) {
          // Beyond free quota — user should have been charged via pre-send.
          // As a safety net, verify they still have coins.
          if (user.coins < COST_PER_MESSAGE) {
            console.log(
              `❌ [WEBHOOK] Rejected: User ${userId} has ${user.coins} coins ` +
              `(needs ${COST_PER_MESSAGE}) for channel ${channelId}`
            );
            res.status(403).json({
              error: `Insufficient coins. You need ${COST_PER_MESSAGE} coins to send a message.`,
            });
            return;
          }
        }
      }

      // ── All good ───────────────────────────────────────────────────
      console.log(`✅ [WEBHOOK] Message validated`);
      res.status(200).json({ success: true });
      return;
    }

    // Other event types — acknowledge
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ [WEBHOOK] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
