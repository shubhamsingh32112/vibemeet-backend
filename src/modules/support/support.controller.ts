import type { Request } from 'express';
import { Response } from 'express';
import { User } from '../user/user.model';
import { SupportTicket } from './support.model';
import { SupportDailyCounter } from './support-daily-counter.model';
import { emitToAdmin } from '../admin/admin.gateway';
import { invalidateAdminCaches } from '../../config/redis';
import { Creator } from '../creator/creator.model';
import { CallHistory } from '../billing/call-history.model';
import { isAgencyRole, isBdRole } from '../../utils/staff-roles';

type CreatorResolution = {
  creatorUserId?: any;
  creatorFirebaseUid?: string;
  creatorName?: string;
};

const MAX_DAILY_TICKETS = 5;
const MAX_SUPPORT_ATTACHMENTS = 5;
const MAX_SUPPORT_ATTACHMENT_BYTES = 1500000;
const ALLOWED_SUPPORT_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

type NormalizedSupportAttachment = {
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataBase64: string;
  isScreenshot: boolean;
};

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

const normalizeSupportAttachments = (raw: unknown): NormalizedSupportAttachment[] => {
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

    let normalizedAttachments: NormalizedSupportAttachment[] = [];
    try {
      normalizedAttachments = normalizeSupportAttachments(attachments);
    } catch (error: any) {
      res.status(400).json({ success: false, error: error?.message || 'Invalid attachments' });
      return;
    }

    // Auto-detect role for ticket queue (agency / BD tickets go to super-admin support).
    const ticketRole = resolveTicketRole(currentUser.role);
    const staffPortal = isStaffPortalUser(currentUser.role);

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
    const ticketPriority = priority && validPriorities.includes(priority) ? priority : 'medium';
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
        attachments: normalizedAttachments,
        priority: ticketPriority,
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

    res.status(201).json({
      success: true,
      data: {
        ticketId: ticket._id.toString(),
        role: ticket.role,
        category: ticket.category,
        subject: ticket.subject,
        attachments: (ticket.attachments || []).map((attachment) => ({
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          isScreenshot: Boolean(attachment.isScreenshot),
          dataBase64: attachment.dataBase64,
          dataUrl: `data:${attachment.mimeType};base64,${attachment.dataBase64}`,
        })),
        status: ticket.status,
        priority: ticket.priority,
        createdAt: ticket.createdAt.toISOString(),
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
        tickets: tickets.map((t) => ({
          id: t._id.toString(),
          role: t.role,
          category: t.category,
          subject: t.subject,
          message: t.message,
          attachments: (t.attachments || []).map((attachment) => ({
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            isScreenshot: Boolean(attachment.isScreenshot),
            dataBase64: attachment.dataBase64,
            dataUrl: `data:${attachment.mimeType};base64,${attachment.dataBase64}`,
          })),
          source: t.source || 'other',
          relatedCallId: t.relatedCallId || null,
          reportedCreatorUserId: t.reportedCreatorUserId?.toString() || null,
          reportedCreatorFirebaseUid: t.reportedCreatorFirebaseUid || null,
          reportedCreatorName: t.reportedCreatorName || null,
          status: t.status,
          priority: t.priority,
          adminNotes: t.adminNotes || null,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        })),
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
