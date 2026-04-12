import jwt from 'jsonwebtoken';
import { Server as SocketIOServer, Namespace } from 'socket.io';
import { getIO } from '../../config/socket';
import { logInfo, logWarning, logDebug } from '../../utils/logger';
import { User } from '../user/user.model';

let adminNamespace: Namespace | null = null;

/** Only verified admin JWT sockets join this room — `emitToAdmin` targets it exclusively. */
export const ADMIN_SOCKET_ROOM = 'staff:admin';

/**
 * Set up the /admin Socket.IO namespace.
 *
 * Connections require `handshake.auth.token` (admin JWT) or `Authorization: Bearer <token>`.
 * Unauthenticated clients are rejected in middleware before `connection` fires.
 *
 * Events emitted to admins (via emitToAdmin):
 *   - billing:settled, creator:status, withdrawal:requested, withdrawal:updated
 *   - support:ticket_created, support:ticket_updated, wallet_pricing_updated, metrics:refresh
 */
export function setupAdminGateway(io: SocketIOServer): void {
  adminNamespace = io.of('/admin');

  adminNamespace.use(async (socket, next) => {
    try {
      const auth = socket.handshake.auth as { token?: string } | undefined;
      const headerAuth =
        typeof socket.handshake.headers.authorization === 'string'
          ? socket.handshake.headers.authorization.replace(/^Bearer\s+/i, '').trim()
          : '';
      const raw = (auth?.token || headerAuth || '').trim();
      if (!raw) {
        return next(new Error('Unauthorized: admin token required'));
      }

      const jwtSecret = (process.env.JWT_SECRET || 'admin-secret-change-me').trim();
      const decoded = jwt.verify(raw, jwtSecret) as { userId?: string; role?: string };
      if (decoded.role !== 'admin' || !decoded.userId) {
        return next(new Error('Forbidden'));
      }

      const adminUser = await User.findById(decoded.userId).select('_id role').lean();
      if (!adminUser || adminUser.role !== 'admin') {
        return next(new Error('Forbidden'));
      }

      socket.data.adminUserId = adminUser._id.toString();
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  adminNamespace.on('connection', (socket) => {
    socket.join(ADMIN_SOCKET_ROOM);
    logDebug('Admin dashboard connected', {
      socketId: socket.id,
      adminUserId: socket.data.adminUserId,
    });

    socket.on('disconnect', (reason) => {
      logDebug('Admin dashboard disconnected', { socketId: socket.id, reason });
    });
  });

  logInfo('Admin namespace /admin ready (JWT required)');
}

/**
 * Emit an event to authenticated admin dashboard clients only.
 */
export function emitToAdmin(event: string, data: unknown): void {
  try {
    const payload =
      data !== null && typeof data === 'object'
        ? { ...(data as Record<string, unknown>), timestamp: new Date().toISOString() }
        : { data, timestamp: new Date().toISOString() };

    if (adminNamespace) {
      adminNamespace.to(ADMIN_SOCKET_ROOM).emit(event, payload);
    } else {
      const io = getIO();
      io.of('/admin').to(ADMIN_SOCKET_ROOM).emit(event, payload);
    }
  } catch (err) {
    logWarning('Failed to emit admin event', { event, error: err });
  }
}
