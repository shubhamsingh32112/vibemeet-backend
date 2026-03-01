import { Server as SocketIOServer, Namespace } from 'socket.io';
import { getIO } from '../../config/socket';
import { logInfo, logWarning, logDebug } from '../../utils/logger';

let adminNamespace: Namespace | null = null;

/**
 * Set up the /admin Socket.IO namespace.
 *
 * Admin dashboard clients connect to `/admin` namespace and receive:
 *   - billing:settled      — after every call settlement
 *   - creator:status       — creator online/offline changes
 *   - withdrawal:requested — new withdrawal request
 *   - withdrawal:updated   — withdrawal approved/rejected/paid
 *   - support:ticket_created — new support ticket
 *   - support:ticket_updated — ticket status changed
 *   - metrics:refresh      — periodic metrics push
 */
export function setupAdminGateway(io: SocketIOServer): void {
  adminNamespace = io.of('/admin');

  adminNamespace.on('connection', (socket) => {
    logDebug('Admin dashboard connected', { socketId: socket.id });

    socket.on('disconnect', (reason) => {
      logDebug('Admin dashboard disconnected', { socketId: socket.id, reason });
    });
  });

  logInfo('Admin namespace /admin ready');
}

/**
 * Emit an event to all connected admin dashboard clients.
 * Safe to call even if no admin clients are connected.
 */
export function emitToAdmin(event: string, data: any): void {
  try {
    if (adminNamespace) {
      adminNamespace.emit(event, {
        ...data,
        timestamp: new Date().toISOString(),
      });
    } else {
      // Try to get from IO instance directly
      const io = getIO();
      io.of('/admin').emit(event, {
        ...data,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    // Silent fail — admin dashboard is optional
    logWarning('Failed to emit admin event', { event, error: err });
  }
}
