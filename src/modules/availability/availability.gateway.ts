import { Server, Socket } from 'socket.io';
import { getFirebaseAdmin } from '../../config/firebase';
import { transitionCreatorPresence, getBatchCreatorPresence } from './presence.service';
import { User } from '../user/user.model';
import { logInfo, logError, logWarning, logDebug } from '../../utils/logger';
import { recordCallMetric } from '../../utils/monitoring';
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

// Track heartbeat intervals for cleanup (per-user, cleared when last socket disconnects)
const creatorHeartbeatIntervals = new Map<string, NodeJS.Timeout>();
const creatorDisconnectTimers = new Map<string, NodeJS.Timeout>();
const CREATOR_DISCONNECT_GRACE_MS = Math.min(
  30000,
  Math.max(0, parseInt(process.env.CREATOR_DISCONNECT_GRACE_MS || '3000', 10) || 3000)
);

// Track how many active sockets each user currently has.
// This prevents marking a user "offline" when one tab/device disconnects
// but another is still connected.
const userSocketCounts = new Map<string, number>();

// Track heartbeat intervals for users (per-user, cleared when last socket disconnects)
const userHeartbeatIntervals = new Map<string, NodeJS.Timeout>();

// Track active socket IDs per user/creator to verify connection status in heartbeat
const activeSocketsByUser = new Map<string, Set<string>>();
const activeSocketsByCreator = new Map<string, Set<string>>();
const lastCreatorHeartbeatAtMs = new Map<string, number>();
const lastUserHeartbeatAtMs = new Map<string, number>();

function creatorHasAnyConnectedSocket(io: Server, firebaseUid: string): boolean {
  const tracked = activeSocketsByCreator.get(firebaseUid);
  if (tracked) {
    for (const socketId of tracked) {
      const socketInstance = io.sockets.sockets.get(socketId);
      if (
        socketInstance?.connected &&
        (socketInstance.data.firebaseUid as string) === firebaseUid
      ) {
        return true;
      }
    }
  }
  for (const [, socketInstance] of io.sockets.sockets) {
    if (
      socketInstance.connected &&
      (socketInstance.data.firebaseUid as string) === firebaseUid &&
      Boolean(socketInstance.data.isCreator)
    ) {
      return true;
    }
  }
  return false;
}

function clearCreatorDisconnectTimer(firebaseUid: string): void {
  const timer = creatorDisconnectTimers.get(firebaseUid);
  if (!timer) return;
  clearTimeout(timer);
  creatorDisconnectTimers.delete(firebaseUid);
}

function scheduleCreatorDisconnectTransition(
  io: Server,
  firebaseUid: string,
  source: string
): void {
  clearCreatorDisconnectTimer(firebaseUid);
  const timer = setTimeout(async () => {
    creatorDisconnectTimers.delete(firebaseUid);
    if (creatorHasAnyConnectedSocket(io, firebaseUid)) {
      logDebug('Creator disconnect grace skipped (socket reconnected)', {
        firebaseUid,
        source,
      });
      return;
    }
    try {
      await transitionCreatorPresence(io, firebaseUid, 'DISCONNECTED', source);
      logInfo('Creator disconnect grace elapsed - set to busy', {
        firebaseUid,
        source,
        graceMs: CREATOR_DISCONNECT_GRACE_MS,
      });
    } catch (err) {
      logError('Failed creator disconnect grace transition', err, {
        firebaseUid,
        source,
        graceMs: CREATOR_DISCONNECT_GRACE_MS,
      });
    }
  }, CREATOR_DISCONNECT_GRACE_MS);
  creatorDisconnectTimers.set(firebaseUid, timer);
}

/**
 * 🔥 SCALABILITY: Periodic cleanup of stale socket tracking entries
 * This is a safety net to catch any edge cases where socket tracking
 * might get out of sync (e.g., server crash, unexpected disconnects)
 * Runs every 10 minutes to clean up orphaned entries
 */
function cleanupStaleSocketTracking(io: Server): void {
  let cleanedUsers = 0;
  let cleanedCreators = 0;
  
  // Clean up user socket tracking
  for (const [firebaseUid, socketIds] of activeSocketsByUser.entries()) {
    // Remove any socket IDs that are no longer connected
    for (const socketId of Array.from(socketIds)) {
      const socketInstance = io.sockets.sockets.get(socketId);
      if (!socketInstance || !socketInstance.connected) {
        socketIds.delete(socketId);
      }
    }
    
    // If no valid sockets remain, clean up the entry
    if (socketIds.size === 0) {
      activeSocketsByUser.delete(firebaseUid);
      
      // Also clean up heartbeat if it exists
      const heartbeatInterval = userHeartbeatIntervals.get(firebaseUid);
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        userHeartbeatIntervals.delete(firebaseUid);
      }
      
      // Clean up socket count
      userSocketCounts.delete(firebaseUid);
      
      // 🔥 CRITICAL: Set status to offline if we're cleaning up (safety net)
      // This ensures users are marked offline even if disconnect handler missed it
      setUserAvailability(firebaseUid, 'offline').catch((err) => {
        logError('Failed to set user offline during cleanup', err, { firebaseUid });
      });
      
      cleanedUsers++;
    }
  }
  
  // Clean up creator socket tracking
  for (const [firebaseUid, socketIds] of activeSocketsByCreator.entries()) {
    // Remove any socket IDs that are no longer connected
    for (const socketId of Array.from(socketIds)) {
      const socketInstance = io.sockets.sockets.get(socketId);
      if (!socketInstance || !socketInstance.connected) {
        socketIds.delete(socketId);
      }
    }
    
    // If no valid sockets remain, clean up the entry
    if (socketIds.size === 0) {
      activeSocketsByCreator.delete(firebaseUid);
      clearCreatorDisconnectTimer(firebaseUid);
      
      // Also clean up heartbeat if it exists
      const heartbeatInterval = creatorHeartbeatIntervals.get(firebaseUid);
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        creatorHeartbeatIntervals.delete(firebaseUid);
      }
      
      // Clean up socket count
      creatorSocketCounts.delete(firebaseUid);
      
      if (!creatorHasAnyConnectedSocket(io, firebaseUid)) {
        void transitionCreatorPresence(
          io,
          firebaseUid,
          'DISCONNECTED',
          'availability.gateway.cleanup_stale'
        ).catch((err) => {
          logError('Failed to force creator busy during stale cleanup', err, { firebaseUid });
        });
      }

      cleanedCreators++;
    }
  }
  
  if (cleanedUsers > 0 || cleanedCreators > 0) {
    logInfo('Cleaned up stale socket tracking entries', {
      cleanedUsers,
      cleanedCreators,
    });
  }
}

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
  // 🔥 SCALABILITY: Start periodic cleanup of stale socket tracking (safety net)
  // Runs every 10 minutes to catch any edge cases
  setInterval(() => {
    cleanupStaleSocketTracking(io);
  }, 10 * 60 * 1000); // 10 minutes

  // Strict TTL safety sweep: force fallback state if heartbeats go stale.
  setInterval(() => {
    void sweepStaleHeartbeats(io);
  }, 30 * 1000);
  
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
      recordCallMetric('presence.socket_auth_success', 1, { context: 'gateway_connect' });
      logDebug('Socket authenticated', { firebaseUid: decodedToken.uid });
      next();
    } catch (err) {
      const errorCode =
        typeof err === 'object' && err != null && 'code' in err
          ? String((err as { code?: unknown }).code ?? 'unknown')
          : 'unknown';
      const errorMessage =
        typeof err === 'object' && err != null && 'message' in err
          ? String((err as { message?: unknown }).message ?? '')
          : '';
      recordCallMetric('presence.socket_auth_failure', 1, {
        context: 'gateway_connect',
        code: errorCode,
        reason: errorMessage.includes('expired') ? 'id-token-expired' : 'invalid-token',
      });
      logError('Socket authentication failed', err, {
        socketId: socket.id,
        code: errorCode,
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
        // Fail open: join consumers so global broadcasts (like app updates) still reach the client.
        isCreator = false;
        isUser = true;
        logWarning('Defaulting socket role to consumer due to role lookup error', {
          firebaseUid,
          socketId: socket.id,
        });
      }
    }
    socket.data.isCreator = isCreator;
    socket.data.isUser = isUser;

    // Handle creator connection
    if (firebaseUid && isCreator) {
      // 🔥 SCALABILITY: Join creators room for targeted creator-side broadcasts
      socket.join('creators');
      
      const currentCount = creatorSocketCounts.get(firebaseUid) ?? 0;
      creatorSocketCounts.set(firebaseUid, currentCount + 1);
      
      // Track this socket ID for this creator
      if (!activeSocketsByCreator.has(firebaseUid)) {
        activeSocketsByCreator.set(firebaseUid, new Set());
      }
      activeSocketsByCreator.get(firebaseUid)!.add(socket.id);
      
      // 🔥 FIX: Automatically set creator online when first device connects
      // Product requirement: creators are automatically online when app opens
      // Effective busy is derived from active call state, so base presence
      // should still become online on first connection.
      if (currentCount === 0) {
        clearCreatorDisconnectTimer(firebaseUid);
        lastCreatorHeartbeatAtMs.set(firebaseUid, Date.now());
        await setCreatorAvailability(io, firebaseUid, 'online');
        logInfo('Creator automatically set to online on connect', { firebaseUid });
        
        // 🔥 SCALABILITY: Start heartbeat to refresh TTL (prevents auto-expire while connected)
        // Heartbeat runs every 60s, TTL is 120s - ensures status persists even with network hiccups
        const heartbeatInterval = setInterval(async () => {
          try {
            // 🔥 CRITICAL FIX: Verify creator still has active sockets before refreshing
            const activeSockets = activeSocketsByCreator.get(firebaseUid);
            if (!activeSockets || activeSockets.size === 0) {
              if (creatorHasAnyConnectedSocket(io, firebaseUid)) {
                return;
              }
              clearInterval(heartbeatInterval);
              creatorHeartbeatIntervals.delete(firebaseUid);
              await transitionCreatorPresence(
                io,
                firebaseUid,
                'DISCONNECTED',
                'availability.gateway.creator_heartbeat_no_sockets'
              );
              logWarning('Heartbeat stopped: no active sockets', { firebaseUid });
              return;
            }
            
            // Verify at least one socket is still connected
            let hasConnectedSocket = false;
            for (const socketId of activeSockets) {
              const socketInstance = io.sockets.sockets.get(socketId);
              if (socketInstance && socketInstance.connected) {
                hasConnectedSocket = true;
                break;
              }
            }
            
            if (!hasConnectedSocket) {
              if (creatorHasAnyConnectedSocket(io, firebaseUid)) {
                return;
              }
              clearInterval(heartbeatInterval);
              creatorHeartbeatIntervals.delete(firebaseUid);
              activeSocketsByCreator.delete(firebaseUid);
              await transitionCreatorPresence(
                io,
                firebaseUid,
                'DISCONNECTED',
                'availability.gateway.creator_heartbeat_disconnected'
              );
              logWarning('Heartbeat stopped: all sockets disconnected', { firebaseUid });
              return;
            }
            
            lastCreatorHeartbeatAtMs.set(firebaseUid, Date.now());
            await transitionCreatorPresence(
              io,
              firebaseUid,
              'HEARTBEAT',
              'availability.gateway.creator_heartbeat'
            );
            logDebug('Heartbeat refreshed creator presence state', { firebaseUid });
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
      socket.join('consumers');
      const currentCount = userSocketCounts.get(firebaseUid) ?? 0;
      userSocketCounts.set(firebaseUid, currentCount + 1);
      
      // Track this socket ID for this user
      if (!activeSocketsByUser.has(firebaseUid)) {
        activeSocketsByUser.set(firebaseUid, new Set());
      }
      activeSocketsByUser.get(firebaseUid)!.add(socket.id);
      
      // 🔥 NEW: Automatically set user online when first device connects
      // Product requirement: users are automatically online when app opens
      if (currentCount === 0) {
        lastUserHeartbeatAtMs.set(firebaseUid, Date.now());
        await setUserAvailability(firebaseUid, 'online');
        
        // 🔥 SCALABILITY: Broadcast only to creators (not all clients)
        // Regular users don't need to know about other users' online status
        io.to('creators').emit('user:status', { firebaseUid, status: 'online' });
        
        logInfo('User automatically set to online on connect', { firebaseUid });
        
        // 🔥 SCALABILITY: Start heartbeat to refresh TTL (prevents auto-expire while connected)
        const heartbeatInterval = setInterval(async () => {
          try {
            // 🔥 CRITICAL FIX: Verify user still has active sockets before refreshing
            const activeSockets = activeSocketsByUser.get(firebaseUid);
            if (!activeSockets || activeSockets.size === 0) {
              // No active sockets - stop heartbeat and set offline
              clearInterval(heartbeatInterval);
              userHeartbeatIntervals.delete(firebaseUid);
              await setUserAvailability(firebaseUid, 'offline');
              io.to('creators').emit('user:status', { firebaseUid, status: 'offline' });
              logWarning('User heartbeat stopped: no active sockets', { firebaseUid });
              return;
            }
            
            // Verify at least one socket is still connected
            let hasConnectedSocket = false;
            for (const socketId of activeSockets) {
              const socketInstance = io.sockets.sockets.get(socketId);
              if (socketInstance && socketInstance.connected) {
                hasConnectedSocket = true;
                break;
              }
            }
            
            if (!hasConnectedSocket) {
              // All sockets disconnected - stop heartbeat and set offline
              clearInterval(heartbeatInterval);
              userHeartbeatIntervals.delete(firebaseUid);
              activeSocketsByUser.delete(firebaseUid);
              await setUserAvailability(firebaseUid, 'offline');
              io.to('creators').emit('user:status', { firebaseUid, status: 'offline' });
              logWarning('User heartbeat stopped: all sockets disconnected', { firebaseUid });
              return;
            }
            
            await refreshUserAvailability(firebaseUid);
            lastUserHeartbeatAtMs.set(firebaseUid, Date.now());
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
          const resultV2: Record<
            string,
            { status: 'online' | 'busy'; version: number; updatedAt: number; source: string }
          > = {};
          const records = await getBatchCreatorPresence(creatorIds);
          for (const creatorId of creatorIds) {
            const rec = records[creatorId];
            const state = rec?.state ?? 'busy';
            result[creatorId] = state;
            resultV2[creatorId] = {
              status: state,
              version: Math.max(0, Number(rec?.version) || 0),
              updatedAt: Math.max(0, Number(rec?.updatedAt) || Date.now()),
              source: String(rec?.source || 'fallback'),
            };
          }

          logDebug('Availability batch fetched', {
            socketId: socket.id,
            creatorCount: Object.keys(result).length,
          });
          socket.emit('availability:batch', result);
          socket.emit('availability:batch:v2', resultV2);
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
      
      clearCreatorDisconnectTimer(uid);
      lastCreatorHeartbeatAtMs.set(uid, Date.now());
      await transitionCreatorPresence(
        io,
        uid,
        'CONNECTED',
        'availability.gateway.creator_online_event'
      );
      logInfo('Creator set to online', { firebaseUid: uid });
    });

    socket.on('creator:offline', async () => {
      const uid = socket.data.firebaseUid as string | undefined;
      const creator = Boolean(socket.data.isCreator);
      if (!uid || !creator) {
        logWarning('Unauthorized creator:offline request', { socketId: socket.id, firebaseUid: uid });
        return;
      }
      if (creatorHasAnyConnectedSocket(io, uid)) {
        logDebug('Ignoring creator:offline — sockets still connected', { firebaseUid: uid });
        return;
      }
      clearCreatorDisconnectTimer(uid);
      await transitionCreatorPresence(
        io,
        uid,
        'DISCONNECTED',
        'availability.gateway.creator_offline_event'
      );
      lastCreatorHeartbeatAtMs.set(uid, Date.now());
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
      lastUserHeartbeatAtMs.set(uid, Date.now());
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
      lastUserHeartbeatAtMs.set(uid, Date.now());
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
        // Remove socket from tracking
        const creatorSockets = activeSocketsByCreator.get(uid);
        if (creatorSockets) {
          creatorSockets.delete(socket.id);
          if (creatorSockets.size === 0) {
            activeSocketsByCreator.delete(uid);
          }
        }
        
        const currentCount = creatorSocketCounts.get(uid) ?? 0;
        const nextCount = Math.max(currentCount - 1, 0);
        
        if (nextCount === 0) {
          // 🔥 AUTOMATIC OFFLINE: Mark creator as offline when all devices disconnect
          // Product requirement: creators are automatically offline when app closes
          creatorSocketCounts.delete(uid);
          lastCreatorHeartbeatAtMs.delete(uid);
          
          // Stop heartbeat immediately (CRITICAL: must happen before status update)
          const heartbeatInterval = creatorHeartbeatIntervals.get(uid);
          if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            creatorHeartbeatIntervals.delete(uid);
            logDebug('Creator heartbeat stopped on disconnect', { firebaseUid: uid });
          }
          
          if (creatorHasAnyConnectedSocket(io, uid)) {
            logDebug('Creator disconnect ignored — other sockets still connected', {
              firebaseUid: uid,
            });
          } else {
            scheduleCreatorDisconnectTransition(
              io,
              uid,
              'availability.gateway.disconnect_last_socket'
            );
            logInfo('Creator disconnected - pending busy via grace window', {
              firebaseUid: uid,
              graceMs: CREATOR_DISCONNECT_GRACE_MS,
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
        // Remove socket from tracking
        const userSockets = activeSocketsByUser.get(uid);
        if (userSockets) {
          userSockets.delete(socket.id);
          if (userSockets.size === 0) {
            activeSocketsByUser.delete(uid);
          }
        }
        
        const currentCount = userSocketCounts.get(uid) ?? 0;
        const nextCount = Math.max(currentCount - 1, 0);
        
        if (nextCount === 0) {
          // 🔥 AUTOMATIC OFFLINE: Mark user as offline when all devices disconnect
          // Product requirement: users are automatically offline when app closes
          userSocketCounts.delete(uid);
          lastUserHeartbeatAtMs.delete(uid);
          
          // Stop heartbeat immediately (CRITICAL: must happen before status update)
          const heartbeatInterval = userHeartbeatIntervals.get(uid);
          if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            userHeartbeatIntervals.delete(uid);
            logDebug('User heartbeat stopped on disconnect', { firebaseUid: uid });
          }
          
          // 🔥 CRITICAL: Set status to offline and broadcast
          // Even if heartbeat cleanup failed, we MUST set status to offline
          try {
            await setUserAvailability(uid, 'offline');
            // 🔥 SCALABILITY: Broadcast only to creators
            io.to('creators').emit('user:status', { firebaseUid: uid, status: 'offline' });
            logInfo('User disconnected - automatically set to offline', { firebaseUid: uid });
          } catch (err) {
            logError('Failed to set user offline on disconnect', err, { firebaseUid: uid });
            // Even if Redis fails, try to broadcast the status change
            io.to('creators').emit('user:status', { firebaseUid: uid, status: 'offline' });
          }
        } else {
          // Still have other devices connected - just decrement count
          userSocketCounts.set(uid, nextCount);
          logDebug('User device disconnected, but other devices still connected', {
            firebaseUid: uid,
            remainingDevices: nextCount,
          });
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
 *   creator:availability:{uid} = "online" | "offline" (TTL-backed base state)
 *   effective busy/online is derived from active call state during reads/emits
 */
export async function setCreatorAvailability(
  io: Server,
  creatorFirebaseUid: string,
  status: 'online' | 'busy'
): Promise<void> {
  if (status === 'online') {
    clearCreatorDisconnectTimer(creatorFirebaseUid);
  }
  const startedAt = Date.now();
  const transition = await transitionCreatorPresence(
    io,
    creatorFirebaseUid,
    status === 'online' ? 'CONNECTED' : 'FORCE_OFFLINE',
    'availability.gateway.setCreatorAvailability'
  );
  if (transition.state === status) {
    recordCallMetric('presence.creator_status_emit', 1, { status });
  } else {
    recordCallMetric('presence.creator_status_noop', 1, { status });
  }
  recordCallMetric('presence.creator_status_propagation_ms', Date.now() - startedAt, { status });
}

async function sweepStaleHeartbeats(io: Server): Promise<void> {
  const staleAfterMs = AVAILABILITY_TTL_SECONDS * 1000;
  const now = Date.now();

  for (const [uid, lastAt] of lastCreatorHeartbeatAtMs.entries()) {
    if (now - lastAt <= staleAfterMs) continue;
    const sockets = activeSocketsByCreator.get(uid);
    const hasConnectedSocket =
      !!sockets &&
      Array.from(sockets).some((socketId) => {
        const s = io.sockets.sockets.get(socketId);
        return Boolean(s && s.connected);
      });
    if (hasConnectedSocket) continue;
    await transitionCreatorPresence(io, uid, 'DISCONNECTED', 'availability.gateway.heartbeat_sweep');
    clearCreatorDisconnectTimer(uid);
    lastCreatorHeartbeatAtMs.delete(uid);
    activeSocketsByCreator.delete(uid);
    creatorSocketCounts.delete(uid);
    recordCallMetric('presence.ttl_fallback_applied', 1, { role: 'creator', status: 'busy' });
    logWarning('Applied creator TTL fallback to busy', { firebaseUid: uid });
  }

  for (const [uid, lastAt] of lastUserHeartbeatAtMs.entries()) {
    if (now - lastAt <= staleAfterMs) continue;
    const sockets = activeSocketsByUser.get(uid);
    const hasConnectedSocket =
      !!sockets &&
      Array.from(sockets).some((socketId) => {
        const s = io.sockets.sockets.get(socketId);
        return Boolean(s && s.connected);
      });
    if (hasConnectedSocket) continue;
    await setUserAvailability(uid, 'offline');
    io.to('creators').emit('user:status', { firebaseUid: uid, status: 'offline' });
    lastUserHeartbeatAtMs.delete(uid);
    activeSocketsByUser.delete(uid);
    userSocketCounts.delete(uid);
    recordCallMetric('presence.ttl_fallback_applied', 1, { role: 'user', status: 'offline' });
    logWarning('Applied user TTL fallback to offline', { firebaseUid: uid });
  }
}
