import { Server, Socket } from 'socket.io';
import { getRedis, availabilityKey } from '../../config/redis';
import { getFirebaseAdmin } from '../../config/firebase';
import { emitToAdmin } from '../admin/admin.gateway';
import { User } from '../user/user.model';
import { logInfo, logError, logWarning, logDebug } from '../../utils/logger';
import {
  setUserAvailability,
  refreshUserAvailability,
  getBatchUserAvailability,
} from './user-availability.service';

// Keep this aligned with the availability service TTL.
const AVAILABILITY_TTL_SECONDS = 120;

// Heartbeat interval (in ms) - must be less than TTL (120s)
const HEARTBEAT_INTERVAL = 60000; // 60 seconds

// Track how many active sockets each creator currently has.
// This prevents marking a creator "busy" when one tab/device disconnects
// but another is still connected.
const creatorSocketCounts = new Map<string, number>();

// Track heartbeat intervals for cleanup
const creatorHeartbeatIntervals = new Map<string, NodeJS.Timeout>();

// Track how many active sockets each user currently has.
// This prevents marking a user "offline" when one tab/device disconnects
// but another is still connected.
const userSocketCounts = new Map<string, number>();

// Track heartbeat intervals for users
const userHeartbeatIntervals = new Map<string, NodeJS.Timeout>();

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
    let isUser = false;

    if (firebaseUid) {
      try {
        const user = await User.findOne({ firebaseUid }).select('role').lean();
        isCreator = user?.role === 'creator' || user?.role === 'admin';
        isUser = user?.role === 'user' || !user?.role || user?.role === null;
      } catch (err) {
        logError('Failed to resolve user role for socket', err, { firebaseUid, socketId: socket.id });
      }
    }
    socket.data.isCreator = isCreator;
    socket.data.isUser = isUser;

    // Handle creator connection
    if (firebaseUid && isCreator) {
      // 🔥 SCALABILITY: Join creators room for targeted broadcasting
      socket.join('creators');
      
      const currentCount = creatorSocketCounts.get(firebaseUid) ?? 0;
      creatorSocketCounts.set(firebaseUid, currentCount + 1);
      
      // 🔥 FIX: Automatically set creator online when first device connects
      // Product requirement: creators are automatically online when app opens
      if (currentCount === 0) {
        await setCreatorAvailability(io, firebaseUid, 'online');
        logInfo('Creator automatically set to online on connect', { firebaseUid });
        
        // 🔥 SCALABILITY: Start heartbeat to refresh TTL (prevents auto-expire while connected)
        // Heartbeat runs every 60s, TTL is 120s - ensures status persists even with network hiccups
        const heartbeatInterval = setInterval(async () => {
          try {
            const redis = getRedis();
            const status = await redis.get(availabilityKey(firebaseUid));
            if (status === 'online') {
              await redis.setex(availabilityKey(firebaseUid), AVAILABILITY_TTL_SECONDS, 'online');
              logDebug('Heartbeat refreshed TTL', { firebaseUid });
            }
          } catch (err) {
            logError('Heartbeat failed', err, { firebaseUid });
          }
        }, HEARTBEAT_INTERVAL);
        
        // Store interval for cleanup
        creatorHeartbeatIntervals.set(firebaseUid, heartbeatInterval);
      }
    }

    // Handle regular user connection
    if (firebaseUid && isUser) {
      const currentCount = userSocketCounts.get(firebaseUid) ?? 0;
      userSocketCounts.set(firebaseUid, currentCount + 1);
      
      // 🔥 NEW: Automatically set user online when first device connects
      // Product requirement: users are automatically online when app opens
      if (currentCount === 0) {
        await setUserAvailability(firebaseUid, 'online');
        
        // 🔥 SCALABILITY: Broadcast only to creators (not all clients)
        // Regular users don't need to know about other users' online status
        io.to('creators').emit('user:status', { firebaseUid, status: 'online' });
        
        logInfo('User automatically set to online on connect', { firebaseUid });
        
        // 🔥 SCALABILITY: Start heartbeat to refresh TTL (prevents auto-expire while connected)
        const heartbeatInterval = setInterval(async () => {
          try {
            await refreshUserAvailability(firebaseUid);
            logDebug('User heartbeat refreshed TTL', { firebaseUid });
          } catch (err) {
            logError('User heartbeat failed', err, { firebaseUid });
          }
        }, HEARTBEAT_INTERVAL);
        
        // Store interval for cleanup
        userHeartbeatIntervals.set(firebaseUid, heartbeatInterval);
      }
    }

    logDebug('Socket client connected', {
      socketId: socket.id,
      firebaseUid: socket.data.firebaseUid,
      isCreator,
      isUser,
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
          const values = await redis.mget(...keys);

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

    // User online handler
    socket.on('user:online', async () => {
      const uid = socket.data.firebaseUid as string | undefined;
      const isUser = Boolean(socket.data.isUser);
      if (!uid || !isUser) {
        logWarning('Unauthorized user:online request', { socketId: socket.id, firebaseUid: uid });
        return;
      }
      await setUserAvailability(uid, 'online');
      // 🔥 SCALABILITY: Broadcast only to creators
      io.to('creators').emit('user:status', { firebaseUid: uid, status: 'online' });
      logInfo('User set to online', { firebaseUid: uid });
    });

    // User offline handler
    socket.on('user:offline', async () => {
      const uid = socket.data.firebaseUid as string | undefined;
      const isUser = Boolean(socket.data.isUser);
      if (!uid || !isUser) {
        logWarning('Unauthorized user:offline request', { socketId: socket.id, firebaseUid: uid });
        return;
      }
      await setUserAvailability(uid, 'offline');
      // 🔥 SCALABILITY: Broadcast only to creators
      io.to('creators').emit('user:status', { firebaseUid: uid, status: 'offline' });
      logInfo('User set to offline', { firebaseUid: uid });
    });

    // User availability batch request
    socket.on('user:availability:get', async (firebaseUids: string[]) => {
      try {
        if (!Array.isArray(firebaseUids)) {
          socket.emit('user:availability:batch', {});
          return;
        }
        
        const availability = await getBatchUserAvailability(firebaseUids);
        socket.emit('user:availability:batch', availability);
        logDebug('User availability batch fetched', {
          socketId: socket.id,
          userCount: Object.keys(availability).length,
        });
      } catch (err) {
        logError('Error handling user:availability:get', err, { socketId: socket.id });
        socket.emit('user:availability:batch', {});
      }
    });

    socket.on('disconnect', async (reason) => {
      const uid = socket.data.firebaseUid as string | undefined;
      const creator = Boolean(socket.data.isCreator);
      const isUser = Boolean(socket.data.isUser);

      // Handle creator disconnect
      if (uid && creator) {
        const currentCount = creatorSocketCounts.get(uid) ?? 1;
        const nextCount = Math.max(currentCount - 1, 0);
        
        if (nextCount === 0) {
          // 🔥 AUTOMATIC OFFLINE: Mark creator as offline when all devices disconnect
          // Product requirement: creators are automatically offline when app closes
          creatorSocketCounts.delete(uid);
          
          // Stop heartbeat immediately
          const heartbeatInterval = creatorHeartbeatIntervals.get(uid);
          if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            creatorHeartbeatIntervals.delete(uid);
          }
          
          // 🔥 CRITICAL: Set status to busy and broadcast BEFORE cleanup
          // This ensures all clients receive the status change immediately
          try {
            await setCreatorAvailability(io, uid, 'busy');
            logInfo('Creator disconnected - automatically set to offline', { firebaseUid: uid });
          } catch (err) {
            logError('Failed to set creator offline on disconnect', err, { firebaseUid: uid });
            // Even if Redis fails, try to broadcast the status change
            io.emit('creator:status', {
              creatorId: uid,
              status: 'busy',
            });
          }
        } else {
          // Still have other devices connected - just decrement count
          creatorSocketCounts.set(uid, nextCount);
          logDebug('Creator device disconnected, but other devices still connected', {
            firebaseUid: uid,
            remainingDevices: nextCount,
          });
        }
      }

      // Handle user disconnect
      if (uid && isUser) {
        const nextCount = Math.max((userSocketCounts.get(uid) ?? 1) - 1, 0);
        if (nextCount === 0) {
          // 🔥 AUTOMATIC OFFLINE: Mark user as offline when all devices disconnect
          // Product requirement: users are automatically offline when app closes
          userSocketCounts.delete(uid);
          
          // Stop heartbeat
          const heartbeatInterval = userHeartbeatIntervals.get(uid);
          if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            userHeartbeatIntervals.delete(uid);
          }
          
          await setUserAvailability(uid, 'offline');
          // 🔥 SCALABILITY: Broadcast only to creators
          io.to('creators').emit('user:status', { firebaseUid: uid, status: 'offline' });
          logInfo('User disconnected - automatically set to offline', { firebaseUid: uid });
        } else {
          userSocketCounts.set(uid, nextCount);
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
    await redis.setex(availabilityKey(creatorFirebaseUid), AVAILABILITY_TTL_SECONDS, 'online');
  } else {
    // Delete key — absence = busy (the universal default)
    await redis.del(availabilityKey(creatorFirebaseUid));
  }

  // Broadcast to ALL connected clients instantly
  // 🔥 CRITICAL: This ensures all users see status changes in real-time
  io.emit('creator:status', {
    creatorId: creatorFirebaseUid,
    status,
  });
  
  logDebug('Broadcast creator status to all clients', {
    creatorFirebaseUid,
    status,
    connectedClients: io.sockets.sockets.size,
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
