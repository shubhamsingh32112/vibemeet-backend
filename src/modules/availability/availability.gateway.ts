import { Server, Socket } from 'socket.io';
import { getRedis, availabilityKey } from '../../config/redis';
import { getFirebaseAdmin } from '../../config/firebase';
import { emitToAdmin } from '../admin/admin.gateway';
import { User } from '../user/user.model';
import { logInfo, logError, logWarning, logDebug } from '../../utils/logger';

// Keep this aligned with the availability service TTL.
const AVAILABILITY_TTL_SECONDS = 120;

// Track how many active sockets each creator currently has.
// This prevents marking a creator "busy" when one tab/device disconnects
// but another is still connected.
const creatorSocketCounts = new Map<string, number>();

function normalizeCreatorIds(data: { creatorIds: string[] } | string[] | undefined): string[] {
  if (Array.isArray(data)) {
    return data.filter((id): id is string => typeof id === 'string');
  }
  if (data && Array.isArray(data.creatorIds)) {
    return data.creatorIds.filter((id): id is string => typeof id === 'string');
  }
  return [];
}

/**
 * Set up Socket.IO gateway for creator availability.
 *
 * Events:
 *   Client → Server:
 *     availability:get  { creatorIds: string[] }   – batch-fetch current statuses
 *
 *   Server → Client:
 *     availability:batch  { [firebaseUid]: "online"|"busy" }  – response to availability:get
 *     creator:status       { creatorId, status }               – real-time incremental update
 */
export function setupAvailabilityGateway(io: Server): void {
  // ── Auth middleware ─────────────────────────────────────────────────────
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      const admin = getFirebaseAdmin();
      const decodedToken = await admin.auth().verifyIdToken(token);
      socket.data.firebaseUid = decodedToken.uid;
      socket.data.email = decodedToken.email;
      logDebug('Socket authenticated', { firebaseUid: decodedToken.uid });
      next();
    } catch (err) {
      logError('Socket authentication failed', err, {
        socketId: socket.id,
      });
      next(new Error('Authentication error: Invalid token'));
    }
  });

  // ── Connection handler ──────────────────────────────────────────────────
  io.on('connection', async (socket: Socket) => {
    const firebaseUid = socket.data.firebaseUid as string | undefined;
    let isCreator = false;

    if (firebaseUid) {
      try {
        const user = await User.findOne({ firebaseUid }).select('role').lean();
        isCreator = user?.role === 'creator' || user?.role === 'admin';
      } catch (err) {
        logError('Failed to resolve user role for socket', err, { firebaseUid, socketId: socket.id });
      }
    }
    socket.data.isCreator = isCreator;

    if (firebaseUid && isCreator) {
      creatorSocketCounts.set(firebaseUid, (creatorSocketCounts.get(firebaseUid) ?? 0) + 1);
    }

    logDebug('Socket client connected', {
      socketId: socket.id,
      firebaseUid: socket.data.firebaseUid,
      isCreator,
    });

    // ── availability:get ────────────────────────────────────────────────
    socket.on(
      'availability:get',
      async (data: { creatorIds: string[] } | string[]) => {
        try {
          const creatorIds = normalizeCreatorIds(data);
          if (creatorIds.length === 0) {
            logWarning('Invalid availability:get payload', { socketId: socket.id });
            socket.emit('availability:batch', {});
            return;
          }

          const result: Record<string, string> = {};
          const redis = getRedis();

          // Build keys array for batch fetch
          const keys = creatorIds.map((id) => availabilityKey(id));

          // MGET: one round-trip for all keys
          const values = await redis.mget<(string | null)[]>(...keys);

          // Map results — null / missing → "busy", "online" → "online"
          for (let i = 0; i < creatorIds.length; i++) {
            const val = values[i];
            result[creatorIds[i]] = val === 'online' ? 'online' : 'busy';
          }

          logDebug('Availability batch fetched', {
            socketId: socket.id,
            creatorCount: Object.keys(result).length,
          });
          socket.emit('availability:batch', result);
        } catch (err) {
          logError('Error handling availability:get', err, { socketId: socket.id });
          socket.emit('availability:batch', {});
        }
      }
    );

    // Creator self-presence toggle (used by frontend AvailabilitySocketService).
    socket.on('creator:online', async () => {
      const uid = socket.data.firebaseUid as string | undefined;
      const creator = Boolean(socket.data.isCreator);
      if (!uid || !creator) {
        logWarning('Unauthorized creator:online request', { socketId: socket.id, firebaseUid: uid });
        return;
      }
      await setCreatorAvailability(io, uid, 'online');
      logInfo('Creator set to online', { firebaseUid: uid });
    });

    socket.on('creator:offline', async () => {
      const uid = socket.data.firebaseUid as string | undefined;
      const creator = Boolean(socket.data.isCreator);
      if (!uid || !creator) {
        logWarning('Unauthorized creator:offline request', { socketId: socket.id, firebaseUid: uid });
        return;
      }
      await setCreatorAvailability(io, uid, 'busy');
      logInfo('Creator set to offline', { firebaseUid: uid });
    });

    socket.on('disconnect', async (reason) => {
      const uid = socket.data.firebaseUid as string | undefined;
      const creator = Boolean(socket.data.isCreator);

      if (uid && creator) {
        const nextCount = Math.max((creatorSocketCounts.get(uid) ?? 1) - 1, 0);
        if (nextCount === 0) {
          creatorSocketCounts.delete(uid);
          await setCreatorAvailability(io, uid, 'busy');
          logInfo('Creator disconnected - set to busy', { firebaseUid: uid });
        } else {
          creatorSocketCounts.set(uid, nextCount);
        }
      }

      logDebug('Socket client disconnected', {
        socketId: socket.id,
        firebaseUid: socket.data.firebaseUid,
        reason,
      });
    });
  });
}

/**
 * Set creator availability in Redis and broadcast to all connected clients.
 * Called from the REST endpoint when a creator toggles their status.
 *
 * Redis contract:
 *   key exists  → value is "online"
 *   key absent  → creator is busy (default)
 */
export async function setCreatorAvailability(
  io: Server,
  creatorFirebaseUid: string,
  status: 'online' | 'busy'
): Promise<void> {
  const redis = getRedis();

  if (status === 'online') {
    await redis.set(availabilityKey(creatorFirebaseUid), 'online', {
      ex: AVAILABILITY_TTL_SECONDS,
    });
  } else {
    // Delete key — absence = busy (the universal default)
    await redis.del(availabilityKey(creatorFirebaseUid));
  }

  // Broadcast to ALL connected clients instantly
  io.emit('creator:status', {
    creatorId: creatorFirebaseUid,
    status,
  });

  // Emit to admin dashboard
  emitToAdmin('creator:status', {
    creatorFirebaseUid,
    status,
  });

  logDebug('Broadcast creator status', {
    creatorFirebaseUid,
    status,
  });
}
