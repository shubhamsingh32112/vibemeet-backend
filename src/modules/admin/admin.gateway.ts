import jwt from 'jsonwebtoken';
import { Server as SocketIOServer, Namespace } from 'socket.io';
import { logInfo, logDebug } from '../../utils/logger';
import { User } from '../user/user.model';
import {
  isSuperAdminRole,
  isBdRole,
  isAgencyRole,
  isBdStaffDisabled,
  isAgencyStaffDisabled,
} from '../../utils/staff-roles';
import {
  ADMIN_SOCKET_ROOM,
  agencySocketRoom,
  bdSocketRoom,
} from '../staff/staff-socket.constants';

let adminNamespace: Namespace | null = null;

export { ADMIN_SOCKET_ROOM, agencySocketRoom, bdSocketRoom };

export function getStaffNamespace(): Namespace | null {
  return adminNamespace;
}

function jwtRoleMatchesMongoStaff(tokenRole: string, mongoRole: string): boolean {
  if (tokenRole === 'admin' || tokenRole === 'super_admin') {
    return isSuperAdminRole(mongoRole);
  }
  if (tokenRole === 'bd') {
    return isBdRole(mongoRole);
  }
  if (tokenRole === 'agency') {
    return isAgencyRole(mongoRole);
  }
  return false;
}

/** Join scoped rooms by staff role — isolated for future section-scoped agency rooms. */
export function joinStaffDashboardRooms(
  socket: { join: (room: string) => void },
  staff: { userId: string; role: string; bdId?: string }
): string[] {
  const rooms: string[] = [];
  if (isSuperAdminRole(staff.role)) {
    socket.join(ADMIN_SOCKET_ROOM);
    rooms.push(ADMIN_SOCKET_ROOM);
  } else if (isBdRole(staff.role)) {
    const bdRoom = bdSocketRoom(staff.userId);
    socket.join(bdRoom);
    rooms.push(bdRoom);
  } else if (isAgencyRole(staff.role)) {
    const room = agencySocketRoom(staff.userId);
    socket.join(room);
    rooms.push(room);
    if (staff.bdId) {
      const parentBdRoom = bdSocketRoom(staff.bdId);
      socket.join(parentBdRoom);
      rooms.push(parentBdRoom);
    }
  }
  return rooms;
}

/**
 * Set up the /admin Socket.IO namespace for all staff dashboard portals.
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
        return next(new Error('Unauthorized: staff token required'));
      }

      const jwtSecret = (process.env.JWT_SECRET || 'admin-secret-change-me').trim();
      const decoded = jwt.verify(raw, jwtSecret) as { userId?: string; role?: string };
      if (!decoded.userId || !decoded.role) {
        return next(new Error('Forbidden'));
      }

      const staffUser = await User.findById(decoded.userId)
        .select('_id role bdId agencyDisabled bdDisabled')
        .lean();
      if (!staffUser || !jwtRoleMatchesMongoStaff(decoded.role, staffUser.role)) {
        return next(new Error('Forbidden'));
      }

      if (isBdRole(staffUser.role) && isBdStaffDisabled(staffUser)) {
        return next(new Error('Forbidden'));
      }
      if (isAgencyRole(staffUser.role) && isAgencyStaffDisabled(staffUser)) {
        return next(new Error('Forbidden'));
      }

      const isStaff =
        isSuperAdminRole(staffUser.role) ||
        isBdRole(staffUser.role) ||
        isAgencyRole(staffUser.role);
      if (!isStaff) {
        return next(new Error('Forbidden'));
      }

      socket.data.staffUserId = staffUser._id.toString();
      socket.data.staffRole = staffUser.role;
      socket.data.bdId = staffUser.bdId?.toString();
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  adminNamespace.on('connection', (socket) => {
    const rooms = joinStaffDashboardRooms(socket, {
      userId: socket.data.staffUserId as string,
      role: socket.data.staffRole as string,
      bdId: socket.data.bdId as string | undefined,
    });
    logDebug('Staff dashboard connected', {
      socketId: socket.id,
      staffUserId: socket.data.staffUserId,
      role: socket.data.staffRole,
      rooms,
    });

    socket.on('disconnect', (reason) => {
      logDebug('Staff dashboard disconnected', { socketId: socket.id, reason });
    });
  });

  logInfo('Staff dashboard namespace /admin ready (staff JWT required)');
}

export { emitToAdmin } from '../staff/staff-dashboard-invalidation.service';
