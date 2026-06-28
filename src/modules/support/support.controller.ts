import type { Request } from 'express';
import { Response } from 'express';
import { User } from '../user/user.model';
import { SupportTicket, type ISupportTicket, type ISupportTicketAttachment } from './support.model';
import { SupportDailyCounter } from './support-daily-counter.model';
import { emitToAdmin } from '../admin/admin.gateway';
import { invalidateAdminCaches } from '../../config/redis';
import { Creator } from '../creator/creator.model';
import { CallHistory } from '../billing/call-history.model';
import { isAgencyRole, isBdRole } from '../../utils/staff-roles';
import { validateSupportContactPhone } from './support-phone.util';
import { mapSupportAttachmentsForApi } from './support-attachment.mapper';
import {
  commitSupportAttachmentsFromSessions,
  SupportAttachmentCommitError,
} from './support-attachment-commit.service';
import { featureFlags } from '../../config/feature-flags';
import { resolveMembershipTier } from '../membership/resolve-membership-tier';
import type { MembershipTier } from '../membership/membership-tier';
import {
  assertCloudflareEnabled,
  CloudflareImagesDisabledError,
} from '../../config/cloudflare';

type CreatorResolution = {
  creatorUserId?: any;
  creatorFirebaseUid?: string;
  creatorName?: string;
};

const MAX_DAILY_TICKETS = 5;
const MAX_SUPPORT_ATTACHMENTS = 5;
const MAX_SUPPORT_ATTACHMENT_BYTES = 1500000;
const ALLOWED_SUPPORT_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

type NormalizedLegacyAttachment = {
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataBase64: string;
  isScreenshot: boolean;
};

function serializeTicketForApi(t: ISupportTicket | Record<string, any>) {
  const id = typeof t._id?.toString === 'function' ? t._id.toString() : String(t.id || t._id || '');
  return {
    id,
    userId: t.userId?.toString?.() ?? String(t.userId || ''),
    role: t.role,
    category: t.category,
    subject: t.subject,
    message: t.message,
    contactPhone: t.contactPhone || null,
    attachments: mapSupportAttachmentsForApi(t.attachments as ISupportTicketAttachment[]),
    source: t.source || 'other',
    relatedCallId: t.relatedCallId || null,
    reportedCreatorUserId: t.reportedCreatorUserId?.toString?.() || null,
    reportedCreatorFirebaseUid: t.reportedCreatorFirebaseUid || null,
    reportedCreatorName: t.reportedCreatorName || null,
    status: t.status,
    priority: t.priority,
    assignedAdminId: t.assignedAdminId?.toString?.() || null,
    adminNotes: t.adminNotes || null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

function resolveTicketRole(userRole: string): 'user' | 'creator' | 'agency' | 'bd' {
  if (userRole === 'creator') return 'creator';
  if (isAgencyRole(userRole)) return 'agency';
  if (isBdRole(userRole)) return 'bd';
  return 'user';
}

function isStaffPortalUser(userRole: string): boolean {
  return isAgencyRole(userRole) || isBdRole(userRole);
}

const getUtcDayKey = (d: Date): string => d.toISOString().slice(0, 10);

const reserveDailySupportTicketSlot = async (userId: string): Promise<boolean> => {
  const dayKey = getUtcDayKey(new Date());

  const existing = await SupportDailyCounter.findOneAndUpdate(
    { userId, dayKey, count: { $lt: MAX_DAILY_TICKETS } },
    { $inc: { count: 1 } },
    { new: true }
  ).lean();

  if (existing) return true;

  try {
    await SupportDailyCounter.create({
      userId,
      dayKey,
      count: 1,
    });
    return true;
  } catch (error: any) {
    if (error?.code !== 11000) {
      throw error;
    }
  }

  const retried = await SupportDailyCounter.findOneAndUpdate(
    { userId, dayKey, count: { $lt: MAX_DAILY_TICKETS } },
    { $inc: { count: 1 } },
    { new: true }
  ).lean();

  return Boolean(retried);
};

const releaseDailySupportTicketSlot = async (userId: string): Promise<void> => {
  const dayKey = getUtcDayKey(new Date());
  await SupportDailyCounter.updateOne(
    { userId, dayKey, count: { $gt: 0 } },
    { $inc: { count: -1 } }
  );
};

const normalizeLegacySupportAttachments = (raw: unknown): NormalizedLegacyAttachment[] => {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('Attachments must be an array');
  }
  if (raw.length > MAX_SUPPORT_ATTACHMENTS) {
    throw new Error(`You can upload up to ${MAX_SUPPORT_ATTACHMENTS} attachments`);
  }

  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Attachment #${index + 1} is invalid`);
    }
    const record = entry as Record<string, unknown>;
    const nameRaw = typeof record.name === 'string' ? record.name.trim() : '';
    const mimeTypeRaw = typeof record.mimeType === 'string' ? record.mimeType.trim().toLowerCase() : '';
    const dataBase64Raw = typeof record.dataBase64 === 'string' ? record.dataBase64.trim() : '';
    const declaredSize = Number(record.sizeBytes);
    const safeName = nameRaw.length > 0 ? nameRaw.slice(0, 120) : `attachment-${index + 1}`;

    if (!ALLOWED_SUPPORT_MIME_TYPES.has(mimeTypeRaw)) {
      throw new Error(`Attachment #${index + 1} has unsupported format`);
    }
    if (!dataBase64Raw) {
      throw new Error(`Attachment #${index + 1} is missing image data`);
    }

    let decoded: Buffer;
    try {
      decoded = Buffer.from(dataBase64Raw, 'base64');
    } catch {
      throw new Error(`Attachment #${index + 1} has invalid image encoding`);
    }
    if (!decoded || decoded.length === 0) {
      throw new Error(`Attachment #${index + 1} is empty`);
    }
    if (decoded.length > MAX_SUPPORT_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachment #${index + 1} is too large. Max ${Math.floor(
          MAX_SUPPORT_ATTACHMENT_BYTES / 1000000
        )} MB per file.`
      );
    }
    if (!Number.isFinite(declaredSize) || declaredSize <= 0) {
      throw new Error(`Attachment #${index + 1} has invalid size`);
    }
    if (Math.abs(declaredSize - decoded.length) > 2048) {
      throw new Error(`Attachment #${index + 1} size mismatch`);
    }

    return {
      name: safeName,
      mimeType: mimeTypeRaw,
      sizeBytes: decoded.length,
      dataBase64: dataBase64Raw,
      isScreenshot: Boolean(record.isScreenshot),
    };
  });
};

const resolveReportedCreator = async (params: {
  creatorLookupId?: string;
  creatorFirebaseUid?: string;
}): Promise<CreatorResolution> => {
  const lookupId = params.creatorLookupId?.trim();
  const firebaseUid = params.creatorFirebaseUid?.trim();

  if (lookupId) {
    const creatorDoc = await Creator.findById(lookupId).lean();
    if (creatorDoc?.userId) {
      const creatorUser = await User.findById(creatorDoc.userId)
        .select('_id firebaseUid username email')
        .lean();
      if (creatorUser) {
        return {
          creatorUserId: creatorUser._id,
          creatorFirebaseUid: creatorUser.firebaseUid,
          creatorName: creatorUser.username || creatorUser.email || 'Creator',
        };
      }
    }

    const asCreatorUser = await User.findById(lookupId)
      .select('_id firebaseUid username email role')
      .lean();
    if (asCreatorUser && (asCreatorUser.role === 'creator' || asCreatorUser.role === 'admin')) {
      return {
        creatorUserId: asCreatorUser._id,
        creatorFirebaseUid: asCreatorUser.firebaseUid,
        creatorName: asCreatorUser.username || asCreatorUser.email || 'Creator',
      };
    }
  }

  if (firebaseUid) {
    const creatorUser = await User.findOne({ firebaseUid })
      .select('_id firebaseUid username email role')
      .lean();
    if (creatorUser && (creatorUser.role === 'creator' || creatorUser.role === 'admin')) {
      return {
        creatorUserId: creatorUser._id,
        creatorFirebaseUid: creatorUser.firebaseUid,
        creatorName: creatorUser.username || creatorUser.email || 'Creator',
      };
    }
  }

  return {};
};

// ══════════════════════════════════════════════════════════════════════════
// USER & CREATOR ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════

/**
 * POST /support/attachments/commit
 *
 * Commit Cloudflare direct-upload sessions into support attachment refs.
 * Body: { sessionIds: string[], sessionMeta?: { sessionId, name?, isScreenshot? }[] }
 */
export const commitSupportAttachments = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    try {
      assertCloudflareEnabled();
    } catch (error) {
      if (error instanceof CloudflareImagesDisabledError) {
        res.status(503).json({
          success: false,
          code: 'IMAGES_DISABLED',
          error: 'Image uploads are temporarily unavailable',
        });
        return;
      }
      throw error;
    }

    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const rawIds = req.body?.sessionIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      res.status(400).json({ success: false, error: 'sessionIds must be a non-empty array' });
      return;
    }
    if (rawIds.length > MAX_SUPPORT_ATTACHMENTS) {
      res.status(400).json({
        success: false,
        error: `You can upload up to ${MAX_SUPPORT_ATTACHMENTS} attachments`,
      });
      return;
    }

    const sessionIds = rawIds
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .map((id) => id.trim());

    const rawMeta = req.body?.sessionMeta;
    const sessionMeta = Array.isArray(rawMeta)
      ? rawMeta
          .filter((m) => m && typeof m === 'object' && typeof (m as any).sessionId === 'string')
          .map((m) => ({
            sessionId: String((m as any).sessionId).trim(),
            name: typeof (m as any).name === 'string' ? (m as any).name : undefined,
            isScreenshot: Boolean((m as any).isScreenshot),
          }))
      : undefined;

    const attachments = await commitSupportAttachmentsFromSessions({
      userId: currentUser._id.toString(),
      userObjectId: currentUser._id,
      sessionIds,
      sessionMeta,
    });

    res.json({
      success: true,
      data: {
        attachments: mapSupportAttachmentsForApi(attachments),
      },
    });
  } catch (error) {
    if (error instanceof SupportAttachmentCommitError) {
      res.status(error.status).json({ success: false, error: error.message });
      return;
    }
    console.error('❌ [SUPPORT] Commit attachments error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/**
 * POST /support/ticket
 *
 * Create a support ticket. Role is auto-set from the user's role.
 * Body: {
 *   category, subject, message, priority?,
 *   source?, relatedCallId?, creatorLookupId?, creatorFirebaseUid?
 * }
 */
export const createTicket = async (req: Request, res: Response): Promise<void> => {
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

    const {
      category,
      subject,
      message,
      priority,
      source,
      relatedCallId,
      creatorLookupId,
      creatorFirebaseUid,
      attachments,
      attachmentSessionIds,
      contactPhone,
    } = req.body;

    if (!category || typeof category !== 'string' || category.trim().length < 2) {
      res.status(400).json({ success: false, error: 'Category is required (min 2 characters)' });
      return;
    }

    if (!subject || typeof subject !== 'string' || subject.trim().length < 3) {
      res.status(400).json({ success: false, error: 'Subject is required (min 3 characters)' });
      return;
    }

    if (!message || typeof message !== 'string' || message.trim().length < 10) {
      res.status(400).json({ success: false, error: 'Message is required (min 10 characters)' });
      return;
    }

    // Auto-detect role for ticket queue (agency / BD tickets go to super-admin support).
    const ticketRole = resolveTicketRole(currentUser.role);
    const staffPortal = isStaffPortalUser(currentUser.role);

    let normalizedContactPhone: string | undefined;
    if (!staffPortal) {
      try {
        normalizedContactPhone = validateSupportContactPhone(contactPhone);
      } catch (error: any) {
        res.status(400).json({ success: false, error: error?.message || 'Invalid phone number' });
        return;
      }
    } else if (typeof contactPhone === 'string' && contactPhone.trim().length > 0) {
      try {
        normalizedContactPhone = validateSupportContactPhone(contactPhone);
      } catch {
        normalizedContactPhone = contactPhone.trim().slice(0, 20);
      }
    }

    const hasLegacyAttachments = attachments != null && (
      Array.isArray(attachments) ? attachments.length > 0 : true
    );
    const hasSessionAttachments =
      Array.isArray(attachmentSessionIds) && attachmentSessionIds.length > 0;

    if (hasLegacyAttachments && hasSessionAttachments) {
      res.status(400).json({
        success: false,
        error: 'Use either attachments or attachmentSessionIds, not both',
      });
      return;
    }

    let ticketAttachments: ISupportTicketAttachment[] = [];

    if (hasSessionAttachments) {
      if (attachmentSessionIds.length > MAX_SUPPORT_ATTACHMENTS) {
        res.status(400).json({
          success: false,
          error: `You can upload up to ${MAX_SUPPORT_ATTACHMENTS} attachments`,
        });
        return;
      }
      try {
        assertCloudflareEnabled();
      } catch (error) {
        if (error instanceof CloudflareImagesDisabledError) {
          res.status(503).json({
            success: false,
            code: 'IMAGES_DISABLED',
            error: 'Image uploads are temporarily unavailable',
          });
          return;
        }
        throw error;
      }
      const sessionIds = attachmentSessionIds
        .filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)
        .map((id: string) => id.trim());
      const rawMeta = req.body?.attachmentSessionMeta;
      const sessionMeta = Array.isArray(rawMeta)
        ? rawMeta
            .filter((m) => m && typeof m === 'object' && typeof (m as any).sessionId === 'string')
            .map((m) => ({
              sessionId: String((m as any).sessionId).trim(),
              name: typeof (m as any).name === 'string' ? (m as any).name : undefined,
              isScreenshot: Boolean((m as any).isScreenshot),
            }))
        : undefined;
      try {
        ticketAttachments = await commitSupportAttachmentsFromSessions({
          userId: currentUser._id.toString(),
          userObjectId: currentUser._id,
          sessionIds,
          sessionMeta,
        });
      } catch (error) {
        if (error instanceof SupportAttachmentCommitError) {
          res.status(error.status).json({ success: false, error: error.message });
          return;
        }
        throw error;
      }
    } else if (hasLegacyAttachments) {
      try {
        const legacy = normalizeLegacySupportAttachments(attachments);
        ticketAttachments = legacy.map((a) => ({
          name: a.name,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          dataBase64: a.dataBase64,
          isScreenshot: a.isScreenshot,
        }));
      } catch (error: any) {
        res.status(400).json({ success: false, error: error?.message || 'Invalid attachments' });
        return;
      }
    }

    let ticketSlotReserved = true;
    if (!staffPortal) {
      ticketSlotReserved = await reserveDailySupportTicketSlot(currentUser._id.toString());
      if (!ticketSlotReserved) {
        res.status(429).json({
          success: false,
          error: `You can submit a maximum of ${MAX_DAILY_TICKETS} support tickets per day. Please try again later.`,
        });
        return;
      }
    }

    const validPriorities = ['low', 'medium', 'high', 'urgent'];
    let ticketPriority = priority && validPriorities.includes(priority) ? priority : 'medium';
    let submitterMembershipTier: MembershipTier = 'NONE';
    if (!staffPortal && featureFlags.vipSupportEnabled) {
      submitterMembershipTier = await resolveMembershipTier(currentUser._id.toString());
      if (submitterMembershipTier === 'VIP') {
        ticketPriority = 'high';
      }
    }
    const validSources = ['chat', 'post_call', 'other', 'staff_portal'];
    const ticketSource =
      source && validSources.includes(source)
        ? source
        : staffPortal
          ? 'staff_portal'
          : 'other';
    const callId = typeof relatedCallId === 'string' && relatedCallId.trim().length > 0
      ? relatedCallId.trim()
      : undefined;

    const resolvedCreator = await resolveReportedCreator({
      creatorLookupId: typeof creatorLookupId === 'string' ? creatorLookupId : undefined,
      creatorFirebaseUid: typeof creatorFirebaseUid === 'string' ? creatorFirebaseUid : undefined,
    });

    let ticket;
    try {
      ticket = await SupportTicket.create({
        userId: currentUser._id,
        role: ticketRole,
        category: category.trim(),
        subject: subject.trim(),
        message: message.trim(),
        contactPhone: normalizedContactPhone,
        attachments: ticketAttachments,
        priority: ticketPriority,
        submitterMembershipTier,
        source: ticketSource,
        relatedCallId: callId,
        reportedCreatorUserId: resolvedCreator.creatorUserId,
        reportedCreatorFirebaseUid: resolvedCreator.creatorFirebaseUid,
        reportedCreatorName: resolvedCreator.creatorName,
        status: 'open',
      });
    } catch (error) {
      if (!staffPortal) {
        await releaseDailySupportTicketSlot(currentUser._id.toString()).catch(() => {});
      }
      throw error;
    }

    console.log(`✅ [SUPPORT] Ticket created: ${ticket._id} by ${ticketRole} ${currentUser._id}`);

    // Emit to admin dashboard
    emitToAdmin('support:ticket_created', {
      ticketId: ticket._id.toString(),
      role: ticketRole,
      category: ticket.category,
      subject: ticket.subject,
      priority: ticketPriority,
      source: ticketSource,
      relatedCallId: ticket.relatedCallId || null,
      reportedCreatorUserId: ticket.reportedCreatorUserId?.toString() || null,
      reportedCreatorFirebaseUid: ticket.reportedCreatorFirebaseUid || null,
      reportedCreatorName: ticket.reportedCreatorName || null,
    });

    invalidateAdminCaches('overview').catch(() => {});

    const serialized = serializeTicketForApi(ticket);
    res.status(201).json({
      success: true,
      data: {
        ticketId: ticket._id.toString(),
        ...serialized,
        ticket: serialized,
      },
    });
  } catch (error) {
    console.error('❌ [SUPPORT] Create ticket error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/**
 * GET /support/my-tickets
 *
 * Get the current user's own support tickets.
 */
export const getMyTickets = async (req: Request, res: Response): Promise<void> => {
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

    const tickets = await SupportTicket.find({ userId: currentUser._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    res.json({
      success: true,
      data: {
        tickets: tickets.map((t) => serializeTicketForApi(t)),
      },
    });
  } catch (error) {
    console.error('❌ [SUPPORT] Get my tickets error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/**
 * POST /support/call-feedback
 *
 * Submit a 1-5 star rating for a completed call.
 * Body: { callId: string, rating: number, comment?: string }
 */
export const submitCallFeedback = async (req: Request, res: Response): Promise<void> => {
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

    const { callId, rating, comment } = req.body;

    if (!callId || typeof callId !== 'string' || callId.trim().length < 3) {
      res.status(400).json({ success: false, error: 'Valid callId is required' });
      return;
    }

    const parsedRating = Number(rating);
    if (!Number.isInteger(parsedRating) || parsedRating < 1 || parsedRating > 5) {
      res.status(400).json({ success: false, error: 'Rating must be an integer between 1 and 5' });
      return;
    }

    const callEntry = await CallHistory.findOne({
      callId: callId.trim(),
      ownerUserId: currentUser._id,
      ownerRole: 'user',
    });

    if (!callEntry) {
      res.status(404).json({ success: false, error: 'Call not found for this user' });
      return;
    }

    const otherUser = await User.findById(callEntry.otherUserId).select('role').lean();
    if (!otherUser || (otherUser.role !== 'creator' && otherUser.role !== 'admin')) {
      res.status(400).json({ success: false, error: 'Feedback can only be submitted for creator calls' });
      return;
    }

    callEntry.ratingStars = parsedRating;
    callEntry.ratingComment = typeof comment === 'string' && comment.trim().length > 0
      ? comment.trim()
      : undefined;
    callEntry.ratedAt = new Date();
    await callEntry.save();

    res.json({
      success: true,
      data: {
        callId: callEntry.callId,
        rating: callEntry.ratingStars,
        ratedAt: callEntry.ratedAt?.toISOString() || new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('❌ [SUPPORT] Submit call feedback error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
