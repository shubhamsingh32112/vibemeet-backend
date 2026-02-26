import { Server as SocketIOServer, Namespace } from 'socket.io';
import { randomUUID } from 'crypto';
import { getIO } from '../../config/socket';
import { logger } from '../../utils/logger';
import { runWithRequestContext } from '../../utils/request-context';

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
    runWithRequestContext(
      {
        requestId: `ws-${socket.id}-admin-connection-${randomUUID()}`,
        source: 'socket',
        path: '/admin',
        socketId: socket.id,
      },
      () => {
        logger.info('admin.socket.connected');
      },
    );

    socket.on('disconnect', (reason) => {
      runWithRequestContext(
        {
          requestId: `ws-${socket.id}-admin-disconnect-${randomUUID()}`,
          source: 'socket',
          path: '/admin',
          socketId: socket.id,
        },
        () => {
          logger.info('admin.socket.disconnected', { reason });
        },
      );
    });
  });

  logger.info('admin.socket.namespace_ready');
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
    logger.warn('admin.socket.emit_failed', { event, err });
  }
}
