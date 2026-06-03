import { Server, Socket } from 'socket.io';
import { getFirebaseAdmin } from '../../config/firebase';
import {
  transitionCreatorPresence,
  getBatchCreatorPresence,
  normalizeFirebaseUids,
  getCreatorBaseAvailability,
} from './presence.service';
import { clearCreatorActiveCallSlotIfStale } from './creator-active-call-slot.service';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { logInfo, logError, logWarning, logDebug } from '../../utils/logger';
import { logCreatorPresenceSweepSummary } from './creator-presence-audit.service';
import { recordCallMetric } from '../../utils/monitoring';
import { featureFlags } from '../../config/feature-flags';
import {
  setUserAvailability,
  refreshUserAvailability,
  getBatchUserAvailability,
} from './user-availability.service';
// Keep this aligned with the availability service TTL (default 180s).
const AVAILABILITY_TTL_SECONDS = Math.min(
  600,
  Math.max(90, parseInt(process.env.CREATOR_PRESENCE_TTL_SECONDS || '180', 10) || 180)
);

// Heartbeat interval (in ms) - intentionally below TTL with a larger safety margin.
const HEARTBEAT_INTERVAL = Math.min(
  Math.max(20_000, AVAILABILITY_TTL_SECONDS * 1000 - 15_000),
  Math.max(20_000, parseInt(process.env.CREATOR_HEARTBEAT_INTERVAL_MS || '45000', 10) || 45_000)
);

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

function stopCreatorHeartbeat(firebaseUid: string): void {
  const heartbeatInterval = creatorHeartbeatIntervals.get(firebaseUid);
  if (!heartbeatInterval) return;
  clearInterval(heartbeatInterval);
  creatorHeartbeatIntervals.delete(firebaseUid);
  logDebug('Creator heartbeat stopped', { firebaseUid });
}

function parseCreatorOnlinePayload(payload: unknown): { clearStuckCall: boolean } {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const raw = payload as Record<string, unknown>;
    return { clearStuckCall: raw.clearStuckCall === true };
  }
  return { clearStuckCall: false };
}

function startCreatorHeartbeat(io: Server, firebaseUid: string): void {
  if (creatorHeartbeatIntervals.has(firebaseUid)) {
    return;
  }
  lastCreatorHeartbeatAtMs.set(firebaseUid, Date.now());
  const heartbeatInterval = setInterval(async () => {
    try {
      const activeSockets = activeSocketsByCreator.get(firebaseUid);
      if (!activeSockets || activeSockets.size === 0) {
        if (creatorHasAnyConnectedSocket(io, firebaseUid)) {
          return;
        }
        stopCreatorHeartbeat(firebaseUid);
        await transitionCreatorPresence(
          io,
          firebaseUid,
          'DISCONNECTED',
          'availability.gateway.creator_heartbeat_no_sockets'
        );
        logWarning('Heartbeat stopped: no active sockets', { firebaseUid });
        return;
      }

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
        stopCreatorHeartbeat(firebaseUid);
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

      const base = await getCreatorBaseAvailability(firebaseUid);
      if (base === 'offline') {
        stopCreatorHeartbeat(firebaseUid);
        logDebug('Heartbeat stopped: creator base offline (toggle)', { firebaseUid });
        return;
      }

      const nowMs = Date.now();
      const lastHeartbeat = lastCreatorHeartbeatAtMs.get(firebaseUid) || nowMs;
      const driftMs = Math.max(0, nowMs - lastHeartbeat - HEARTBEAT_INTERVAL);
      recordCallMetric('presence.creator_heartbeat_drift_ms', driftMs, {
        role: 'creator',
      });
      lastCreatorHeartbeatAtMs.set(firebaseUid, nowMs);
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
  creatorHeartbeatIntervals.set(firebaseUid, heartbeatInterval);
}

async function handleCreatorExplicitOnline(
  io: Server,
  firebaseUid: string,
  source: string,
  options?: { clearStuckCall?: boolean }
): Promise<void> {
  clearCreatorDisconnectTimer(firebaseUid);
  lastCreatorHeartbeatAtMs.set(firebaseUid, Date.now());
  if (options?.clearStuckCall) {
    const clearResult = await clearCreatorActiveCallSlotIfStale(firebaseUid, {
      source: `${source}.clear_stuck_call`,
    });
    if (!clearResult.cleared && clearResult.reason === 'slot_still_live') {
      recordCallMetric('presence.clear_stuck_call_blocked_live', 1, {
        creatorFirebaseUid: firebaseUid,
        source,
      });
      logInfo('presence.clear_stuck_call_blocked_live', {
        firebaseUid,
        source,
        slotCallId: clearResult.slotCallId,
        timestamp: Date.now(),
      });
    }
  }
  await transitionCreatorPresence(io, firebaseUid, 'CONNECTED', source);
  startCreatorHeartbeat(io, firebaseUid);
  logInfo('creator_status_change', {
    firebaseUid,
    to: 'online',
    eventType: 'CONNECTED',
    source,
    clearStuckCall: options?.clearStuckCall === true,
  });
  logInfo('Creator set to online', { firebaseUid, source });
}

async function handleCreatorExplicitOffline(
  io: Server,
  firebaseUid: string,
  source: string
): Promise<void> {
  clearCreatorDisconnectTimer(firebaseUid);
  stopCreatorHeartbeat(firebaseUid);
  await transitionCreatorPresence(io, firebaseUid, 'FORCE_OFFLINE', source);
  lastCreatorHeartbeatAtMs.delete(firebaseUid);
  logInfo('creator_status_change', {
    firebaseUid,
    to: 'offline',
    eventType: 'FORCE_OFFLINE',
    source,
  });
  logInfo('Creator set to offline', { firebaseUid, source });
}

/**
 * Apply runtime presence from creator availability intent (Redis + broadcast).
 * Mongo isOnline must be updated separately (REST toggle / logout).
 */
export async function applyCreatorAvailabilityIntent(
  io: Server,
  firebaseUid: string,
  isOnline: boolean,
  source: string,
  options?: { clearStuckCall?: boolean }
): Promise<void> {
  if (isOnline) {
    await handleCreatorExplicitOnline(io, firebaseUid, source, options);
  } else {
    await handleCreatorExplicitOffline(io, firebaseUid, source);
  }
}

/**
 * Restore Redis runtime from Mongo Creator.isOnline (intent) after connect / Redis loss.
 */
export async function restoreCreatorRuntimeFromIntent(
  io: Server,
  firebaseUid: string,
  source: string
): Promise<boolean> {
  const user = await User.findOne({ firebaseUid }).select('_id').lean();
  if (!user) {
    return false;
  }
  const creator = await Creator.findOne({ userId: user._id }).select('isOnline').lean();
  if (creator?.isOnline !== true) {
    logDebug('Creator toggle mode: Mongo intent offline — no runtime restore', {
      firebaseUid,
      source,
    });
    return false;
  }
  await handleCreatorExplicitOnline(io, firebaseUid, source, { clearStuckCall: false });
  recordCallMetric('presence.restore_from_mongo', 1, {
    creatorFirebaseUid: firebaseUid,
    source,
  });
  logInfo('presence.restore_from_mongo', {
    firebaseUid,
    source,
    timestamp: Date.now(),
  });
  return true;
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
      logInfo('creator_status_change', {
        firebaseUid,
        from: 'online_or_on_call',
        to: 'offline',
        eventType: 'DISCONNECTED',
        source,
        graceMs: CREATOR_DISCONNECT_GRACE_MS,
      });
      logInfo('Creator disconnect grace elapsed - set to offline', {
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
          logError('Failed to force creator offline during stale cleanup', err, { firebaseUid });
        });
      }

      cleanedCreators++;
    }
  }
  
  logCreatorPresenceSweepSummary('availability.gateway.cleanup_stale_socket_tracking', {
    creatorsForcedOffline: cleanedCreators,
    usersForcedOffline: cleanedUsers,
  });
}

function normalizeCreatorIds(
  data: { creatorIds: string[] } | string[] | undefined
): { firebaseUids: string[]; invalidUids: string[] } {
  const sanitize = (ids: unknown[]): string[] =>
    ids
      .filter((id): id is string => typeof id === 'string')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

  if (Array.isArray(data)) {
    return normalizeFirebaseUids(sanitize(data));
  }
  if (data && Array.isArray(data.creatorIds)) {
    return normalizeFirebaseUids(sanitize(data.creatorIds));
  }
  return { firebaseUids: [], invalidUids: [] };
}

/**
 * Set up Socket.IO gateway for creator availability.
 *
 * Events:
 *   Client → Server:
 *     availability:get  { creatorIds: string[] }   – batch-fetch current statuses
 *
 *   Server → Client:
 *     availability:batch  { [firebaseUid]: "online"|"on_call"|"offline" }  – response to availability:get
 *     creator:status       { creatorId, status, version, updatedAt, source,
 *                            creatorSummary? }                  – real-time incremental update;
 *                          creatorSummary (feed card snapshot) is included when status is
 *                          online or on_call so clients share one authoritative event shape.
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
    let resolvedRole: string | null = null;

    if (firebaseUid) {
      try {
        const user = await User.findOne({ firebaseUid }).select('role').lean();
        resolvedRole = user?.role ?? null;
        isCreator = resolvedRole === 'creator' || resolvedRole === 'admin';
        isUser = resolvedRole === 'user' || !resolvedRole;
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
      // Admins testing the user home feed must also receive fan-facing creator:status events.
      if (resolvedRole === 'admin') {
        socket.join('consumers');
      }
      
      const currentCount = creatorSocketCounts.get(firebaseUid) ?? 0;
      creatorSocketCounts.set(firebaseUid, currentCount + 1);
      
      // Track this socket ID for this creator
      if (!activeSocketsByCreator.has(firebaseUid)) {
        activeSocketsByCreator.set(firebaseUid, new Set());
      }
      activeSocketsByCreator.get(firebaseUid)!.add(socket.id);
      
      if (currentCount === 0) {
        clearCreatorDisconnectTimer(firebaseUid);
        try {
          await restoreCreatorRuntimeFromIntent(
            io,
            firebaseUid,
            'availability.gateway.connect_first_socket'
          );
        } catch (err) {
          logError('Failed creator connect intent restore', err, { firebaseUid });
        }
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
            const nowMs = Date.now();
            const lastHeartbeat = lastUserHeartbeatAtMs.get(firebaseUid) || nowMs;
            const driftMs = Math.max(0, nowMs - lastHeartbeat - HEARTBEAT_INTERVAL);
            recordCallMetric('presence.creator_heartbeat_drift_ms', driftMs, {
              role: 'user',
            });
            lastUserHeartbeatAtMs.set(firebaseUid, nowMs);
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
          const normalized = normalizeCreatorIds(data);
          const firebaseUids = normalized.firebaseUids;
          const processedCount = firebaseUids.length;
          if (normalized.invalidUids.length > 0) {
            const totalInput = firebaseUids.length + normalized.invalidUids.length;
            recordCallMetric('presence.creator_uid_contract_violation', normalized.invalidUids.length, {
              context: 'availability:get',
              mode: featureFlags.creatorPresenceUidContractEnforced ? 'enforce' : 'warn',
            });
            recordCallMetric(
              'presence.creator_uid_contract_violation_rate',
              normalized.invalidUids.length / Math.max(totalInput, 1),
              {
                context: 'availability:get',
                mode: featureFlags.creatorPresenceUidContractEnforced ? 'enforce' : 'warn',
              }
            );
            recordCallMetric('presence.creator_uid_contract_input_size', totalInput, {
              context: 'availability:get',
              mode: featureFlags.creatorPresenceUidContractEnforced ? 'enforce' : 'warn',
            });
            logWarning('availability_get_uid_contract_violation', {
              socketId: socket.id,
              invalidCount: normalized.invalidUids.length,
              validCount: firebaseUids.length,
              processedCount,
              sample: normalized.invalidUids.slice(0, 3),
              enforce: featureFlags.creatorPresenceUidContractEnforced,
            });
            if (featureFlags.creatorPresenceUidContractEnforced && firebaseUids.length === 0) {
              logWarning('availability_get_uid_contract_all_invalid_enforced', {
                socketId: socket.id,
                invalidCount: normalized.invalidUids.length,
                validCount: firebaseUids.length,
                processedCount,
              });
              recordCallMetric('presence.creator_uid_contract_enforced_block', 1, {
                context: 'availability:get',
              });
              socket.emit('availability:batch', {});
              socket.emit('availability:batch:v2', {});
              return;
            }
          }
          if (firebaseUids.length === 0) {
            logWarning('Invalid availability:get payload', { socketId: socket.id });
            socket.emit('availability:batch', {});
            socket.emit('availability:batch:v2', {});
            return;
          }

          const result: Record<string, string> = {};
          const resultV2: Record<
            string,
            { status: 'online' | 'on_call' | 'offline'; version: number; updatedAt: number; source: string }
          > = {};
          const records = await getBatchCreatorPresence(firebaseUids);
          for (const firebaseUid of firebaseUids) {
            const rec = records[firebaseUid];
            const state = rec?.state ?? 'offline';
            result[firebaseUid] = state;
            resultV2[firebaseUid] = {
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

    // Creator explicit availability toggle (production SocketService + REST).
    socket.on('creator:online', async (payload: unknown) => {
      const uid = socket.data.firebaseUid as string | undefined;
      const creator = Boolean(socket.data.isCreator);
      if (!uid || !creator) {
        logWarning('Unauthorized creator:online request', { socketId: socket.id, firebaseUid: uid });
        return;
      }
      const { clearStuckCall } = parseCreatorOnlinePayload(payload);
      try {
        await handleCreatorExplicitOnline(
          io,
          uid,
          'availability.gateway.creator_online_event',
          { clearStuckCall }
        );
      } catch (err) {
        logError('Failed creator:online handler', err, { firebaseUid: uid });
      }
    });

    socket.on('creator:offline', async () => {
      const uid = socket.data.firebaseUid as string | undefined;
      const creator = Boolean(socket.data.isCreator);
      if (!uid || !creator) {
        logWarning('Unauthorized creator:offline request', { socketId: socket.id, firebaseUid: uid });
        return;
      }
      try {
        await handleCreatorExplicitOffline(io, uid, 'availability.gateway.creator_offline_event');
      } catch (err) {
        logError('Failed creator:offline handler', err, { firebaseUid: uid });
      }
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
          
          stopCreatorHeartbeat(uid);
          logDebug('Creator heartbeat stopped on disconnect', { firebaseUid: uid });
          
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
  status: 'online' | 'offline'
): Promise<void> {
  if (status === 'online') {
    clearCreatorDisconnectTimer(creatorFirebaseUid);
  } else {
    stopCreatorHeartbeat(creatorFirebaseUid);
  }
  const startedAt = Date.now();
  const transition = await transitionCreatorPresence(
    io,
    creatorFirebaseUid,
    status === 'online' ? 'CONNECTED' : 'FORCE_OFFLINE',
    'availability.gateway.setCreatorAvailability'
  );
  if (status === 'online') {
    startCreatorHeartbeat(io, creatorFirebaseUid);
  } else {
    lastCreatorHeartbeatAtMs.delete(creatorFirebaseUid);
  }
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
  let creatorHeartbeatStale = 0;
  let userHeartbeatStale = 0;

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
    creatorHeartbeatStale += 1;
    recordCallMetric('presence.ttl_fallback_applied', 1, { role: 'creator', status: 'offline' });
    logWarning('creator_status_stale_ttl_fallback', {
      firebaseUid: uid,
      role: 'creator',
      from: 'online_or_on_call',
      to: 'offline',
      lastHeartbeatAgeMs: now - lastAt,
      staleAfterMs,
    });
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
    userHeartbeatStale += 1;
    recordCallMetric('presence.ttl_fallback_applied', 1, { role: 'user', status: 'offline' });
    logWarning('creator_presence_user_ttl_fallback', {
      firebaseUid: uid,
      role: 'user',
      to: 'offline',
      lastHeartbeatAgeMs: now - lastAt,
      staleAfterMs,
    });
  }

  logCreatorPresenceSweepSummary('availability.gateway.heartbeat_sweep', {
    creatorHeartbeatStale,
    userHeartbeatStale,
  });
}
