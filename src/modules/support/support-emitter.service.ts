import { getIO } from '../../config/socket';
import { User } from '../user/user.model';
import { logDebug } from '../../utils/logger';
import type { ISupportTicket } from './support.model';

export type SupportTicketUpdatedPayload = {
  ticketId: string;
  status: string;
  subject: string;
  adminNotes: string | null;
  updatedAt: string;
  hasNewReply: boolean;
};

/**
 * Notify the ticket submitter when an admin updates status or adds notes.
 * Uses the main Socket.IO namespace room `user:{firebaseUid}`.
 */
export async function emitSupportTicketUpdatedToUser(
  ticket: Pick<ISupportTicket, '_id' | 'userId' | 'status' | 'subject' | 'adminNotes' | 'updatedAt'>,
  options?: { hasNewReply?: boolean },
): Promise<void> {
  try {
    const owner = await User.findById(ticket.userId).select('firebaseUid').lean();
    if (!owner?.firebaseUid) return;

    const payload: SupportTicketUpdatedPayload = {
      ticketId: ticket._id.toString(),
      status: ticket.status,
      subject: ticket.subject ?? 'Support ticket',
      adminNotes: ticket.adminNotes || null,
      updatedAt:
        ticket.updatedAt instanceof Date
          ? ticket.updatedAt.toISOString()
          : new Date().toISOString(),
      hasNewReply: options?.hasNewReply ?? Boolean(ticket.adminNotes?.trim()),
    };

    getIO().to(`user:${owner.firebaseUid}`).emit('support:ticket_updated', payload);
    logDebug('support:ticket_updated emitted to user', {
      ticketId: payload.ticketId,
      firebaseUid: owner.firebaseUid,
    });
  } catch (error) {
    logDebug('support:ticket_updated emit skipped', {
      ticketId: ticket._id?.toString?.(),
      error: (error as Error).message,
    });
  }
}
