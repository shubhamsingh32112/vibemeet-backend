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
import {
  assertCreatorOrAdminForPresenceLookup,
  capPresenceLookupBatch,
  checkPresenceLookupRateLimit,
} from './presence-lookup-access';
import { useRegistryAsAuthoritative } from './presence-registry-flags';
import {
  cleanupLocalMapsForUid,
  getSocketVersion,
  getTrackerSocketCount,
  hasAnyConnectedSocket,
  listTrackedUids,
  getActiveSocketIds,
  onCreatorConnect,
  onCreatorDisconnect,
  onUserConnect,
  onUserDisconnect,
  registry,
  storeSocketVersion,
} from './presence-socket-tracker';
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

// Heartbeat / grace timers (per-process scheduling; socket counts live in presence-socket-tracker)
const creatorHeartbeatIntervals = new Map<string, NodeJS.Timeout>();
const creatorDisconnectTimers = new Map<string, NodeJS.Timeout>();
const CREATOR_DISCONNECT_GRACE_MS = Math.min(
  30000,
  Math.max(0, parseInt(process.env.CREATOR_DISCONNECT_GRACE_MS || '3000', 10) || 3000)
);

const userHeartbeatIntervals = new Map<string, NodeJS.Timeout>();

const lastCreatorHeartbeatAtMs = new Map<string, number>();
const lastUserHeartbeatAtMs = new Map<string, number>();
const creatorGraceTokens = new Map<string, string>();

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
  if (useRegistryAsAuthoritative()) {
    void registry.releaseHeartbeatLease(firebaseUid);
  }
  logDebug('Creator heartbeat stopped', { firebaseUid });
}

function stopUserHeartbeat(firebaseUid: string): void {
  const heartbeatInterval = userHeartbeatIntervals.get(firebaseUid);
  if (!heartbeatInterval) return;
  clearInterval(heartbeatInterval);
  userHeartbeatIntervals.delete(firebaseUid);
  if (useRegistryAsAuthoritative()) {
    void registry.releaseHeartbeatLease(firebaseUid);
  }
  logDebug('User heartbeat stopped', { firebaseUid });
}

function parseCreatorOnlinePayload(payload: unknown): { clearStuckCall: boolean } {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const raw = payload as Record<string, unknown>;
    return { clearStuckCall: raw.clearStuckCall === true };
  }
  return { clearStuckCall: false };
}

/**
 * Lease renew failure policy: stop interval immediately — never retry next tick.
 * Retrying after a lost lease risks double writers; stopping yields to the next lease holder.
 */
async function renewHeartbeatLeaseOrStop(
  firebaseUid: string,
  role: 'creator' | 'user',
  stop: () => void
): Promise<boolean> {
  if (!useRegistryAsAuthoritative()) return true;
  try {
    const renewed = await registry.renewHeartbeatLease(firebaseUid);
    if (!renewed) {
      recordCallMetric('presence.heartbeat_lease_renew_failed', 1, {
        role,
        reason: 'not_holder_or_stale',
      });
      stop();
      return false;
    }
    return true;
  } catch (err) {
    logError('Heartbeat lease renew threw', err, { firebaseUid, role });
    recordCallMetric('presence.heartbeat_lease_renew_failed', 1, { role, reason: 'redis_error' });
    stop();
    return false;
  }
}

async function startCreatorHeartbeat(io: Server, firebaseUid: string): Promise<void> {
  if (creatorHeartbeatIntervals.has(firebaseUid)) {
    return;
  }
  if (useRegistryAsAuthoritative()) {
    const acquired = await registry.tryAcquireHeartbeatLease(firebaseUid);
    if (!acquired) return;
  }
  lastCreatorHeartbeatAtMs.set(firebaseUid, Date.now());
  const heartbeatInterval = setInterval(async () => {
    try {
      if (useRegistryAsAuthoritative()) {
        if (!(await registry.isHeartbeatLeaseHolder(firebaseUid))) {
          stopCreatorHeartbeat(firebaseUid);
          return;
        }
        if (!(await renewHeartbeatLeaseOrStop(firebaseUid, 'creator', () => stopCreatorHeartbeat(firebaseUid)))) {
          return;
        }
      }

      const stillConnected = await hasAnyConnectedSocket(io, firebaseUid, 'creator');
      if (!stillConnected) {
        if (useRegistryAsAuthoritative() && !(await registry.isHeartbeatLeaseHolder(firebaseUid))) {
          stopCreatorHeartbeat(firebaseUid);
          return;
        }
        stopCreatorHeartbeat(firebaseUid);
        cleanupLocalMapsForUid(firebaseUid, 'creator');
        await transitionCreatorPresence(
          io,
          firebaseUid,
          'DISCONNECTED',
          'availability.gateway.creator_heartbeat_no_sockets'
        );
        logWarning('Heartbeat stopped: no active sockets', { firebaseUid });
        return;
      }

      const base = await getCreatorBaseAvailability(firebaseUid);
      if (base === 'offline') {
        stopCreatorHeartbeat(firebaseUid);
        logDebug('Heartbeat stopped: creator base offline (toggle)', { firebaseUid });
        return;
      }

      if (useRegistryAsAuthoritative() && !(await registry.isHeartbeatLeaseHolder(firebaseUid))) {
        recordCallMetric('presence.heartbeat_lease_lost_before_write', 1, { role: 'creator' });
        stopCreatorHeartbeat(firebaseUid);
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

function startUserHeartbeat(io: Server, firebaseUid: string): void {
  if (userHeartbeatIntervals.has(firebaseUid)) {
    return;
  }
  void (async () => {
    if (useRegistryAsAuthoritative()) {
      const acquired = await registry.tryAcquireHeartbeatLease(firebaseUid);
      if (!acquired) return;
    }
    lastUserHeartbeatAtMs.set(firebaseUid, Date.now());
    const heartbeatInterval = setInterval(async () => {
      try {
        if (useRegistryAsAuthoritative()) {
          if (!(await registry.isHeartbeatLeaseHolder(firebaseUid))) {
            clearInterval(heartbeatInterval);
            userHeartbeatIntervals.delete(firebaseUid);
            return;
          }
          if (
            !(await renewHeartbeatLeaseOrStop(firebaseUid, 'user', () => {
              clearInterval(heartbeatInterval);
              userHeartbeatIntervals.delete(firebaseUid);
            }))
          ) {
            return;
          }
        }

        const stillConnected = await hasAnyConnectedSocket(io, firebaseUid, 'user');
        if (!stillConnected) {
          if (useRegistryAsAuthoritative() && !(await registry.isHeartbeatLeaseHolder(firebaseUid))) {
            clearInterval(heartbeatInterval);
            userHeartbeatIntervals.delete(firebaseUid);
            return;
          }
          clearInterval(heartbeatInterval);
          userHeartbeatIntervals.delete(firebaseUid);
          cleanupLocalMapsForUid(firebaseUid, 'user');
          await setUserAvailability(firebaseUid, 'offline');
          io.to('creators').emit('user:status', { firebaseUid, status: 'offline' });
          logWarning('User heartbeat stopped: no active sockets', { firebaseUid });
          return;
        }

        if (useRegistryAsAuthoritative() && !(await registry.isHeartbeatLeaseHolder(firebaseUid))) {
          recordCallMetric('presence.heartbeat_lease_lost_before_write', 1, { role: 'user' });
          clearInterval(heartbeatInterval);
          userHeartbeatIntervals.delete(firebaseUid);
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
    userHeartbeatIntervals.set(firebaseUid, heartbeatInterval);
  })();
}

async function handleCreatorExplicitOnline(
  io: Server,
  firebaseUid: string,
  source: string,
  options?: { clearStuckCall?: boolean }
): Promise<void> {
  clearCreatorDisconnectTimer(firebaseUid);
  const graceToken = creatorGraceTokens.get(firebaseUid);
  if (graceToken && useRegistryAsAuthoritative()) {
    await registry.cancelDisconnectGrace(firebaseUid, graceToken);
    creatorGraceTokens.delete(firebaseUid);
  }
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
  await startCreatorHeartbeat(io, firebaseUid);
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
  void (async () => {
    let graceToken: string | undefined;
    if (useRegistryAsAuthoritative()) {
      const grace = await registry.startDisconnectGrace(firebaseUid);
      graceToken = grace.token;
      creatorGraceTokens.set(firebaseUid, graceToken);
    }
    const timer = setTimeout(async () => {
      creatorDisconnectTimers.delete(firebaseUid);
      if (await hasAnyConnectedSocket(io, firebaseUid, 'creator')) {
        recordCallMetric('presence.grace_callback_skipped', 1, { reason: 'has_socket' });
        logDebug('Creator disconnect grace skipped (socket reconnected)', {
          firebaseUid,
          source,
        });
        return;
      }
      if (useRegistryAsAuthoritative()) {
        const graceStillActive = await registry.isDisconnectGraceActive(firebaseUid);
        if (!graceStillActive) {
          recordCallMetric('presence.grace_callback_skipped', 1, { reason: 'grace_cancelled' });
          logDebug('Creator disconnect grace skipped (grace cancelled)', { firebaseUid, source });
          return;
        }
      }
      try {
        await transitionCreatorPresence(io, firebaseUid, 'DISCONNECTED', source);
        creatorGraceTokens.delete(firebaseUid);
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
  })();
}

/**
 * 🔥 SCALABILITY: Periodic cleanup of stale socket tracking entries
 * This is a safety net to catch any edge cases where socket tracking
 * might get out of sync (e.g., server crash, unexpected disconnects)
 * Runs every 10 minutes to clean up orphaned entries
 */
function cleanupStaleSocketTracking(io: Server): void {
  void (async () => {
    let cleanedUsers = 0;
    let cleanedCreators = 0;

    const sweepRole = async (role: 'creator' | 'user'): Promise<number> => {
      let cleaned = 0;
      const uids = listTrackedUids(role);
      for (const firebaseUid of uids) {
        const socketIds = getActiveSocketIds(firebaseUid, role);
        if (!socketIds) continue;

        if (useRegistryAsAuthoritative()) {
          const registryCount = await getTrackerSocketCount(firebaseUid, role);
          if (registryCount === 0 && socketIds.size > 0) {
            recordCallMetric('presence.registry.shadow_mismatch', 1, {
              role,
              op: 'cleanup_local_orphan',
            });
            cleanupLocalMapsForUid(firebaseUid, role);
            if (role === 'creator') stopCreatorHeartbeat(firebaseUid);
            else stopUserHeartbeat(firebaseUid);
            cleaned++;
          }
          continue;
        }

        for (const socketId of Array.from(socketIds)) {
          const socketInstance = io.sockets.sockets.get(socketId);
          if (!socketInstance || !socketInstance.connected) {
            socketIds.delete(socketId);
          }
        }
        if (socketIds.size === 0) {
          cleanupLocalMapsForUid(firebaseUid, role);
          if (role === 'creator') {
            clearCreatorDisconnectTimer(firebaseUid);
            stopCreatorHeartbeat(firebaseUid);
            if (!(await hasAnyConnectedSocket(io, firebaseUid, 'creator'))) {
              void transitionCreatorPresence(
                io,
                firebaseUid,
                'DISCONNECTED',
                'availability.gateway.cleanup_stale'
              ).catch((err) => {
                logError('Failed to force creator offline during stale cleanup', err, {
                  firebaseUid,
                });
              });
            }
          } else {
            stopUserHeartbeat(firebaseUid);
            setUserAvailability(firebaseUid, 'offline').catch((err) => {
              logError('Failed to set user offline during cleanup', err, { firebaseUid });
            });
          }
          cleaned++;
        }
      }
      return cleaned;
    };

    cleanedUsers = await sweepRole('user');
    cleanedCreators = await sweepRole('creator');

    logCreatorPresenceSweepSummary('availability.gateway.cleanup_stale_socket_tracking', {
      creatorsForcedOffline: cleanedCreators,
      usersForcedOffline: cleanedUsers,
    });
  })();
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
      
      const connectResult = await onCreatorConnect(firebaseUid, socket.id);
      if (connectResult.socketVersion != null) {
        storeSocketVersion(socket, connectResult.socketVersion);
      }

      if (connectResult.isFirstSocket) {
        clearCreatorDisconnectTimer(firebaseUid);
        const graceToken = creatorGraceTokens.get(firebaseUid);
        if (graceToken && useRegistryAsAuthoritative()) {
          await registry.cancelDisconnectGrace(firebaseUid, graceToken);
          creatorGraceTokens.delete(firebaseUid);
        }
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
      const connectResult = await onUserConnect(firebaseUid, socket.id);
      if (connectResult.socketVersion != null) {
        storeSocketVersion(socket, connectResult.socketVersion);
      }

      if (connectResult.isFirstSocket) {
        lastUserHeartbeatAtMs.set(firebaseUid, Date.now());
        await setUserAvailability(firebaseUid, 'online');
        io.to('creators').emit('user:status', { firebaseUid, status: 'online' });
        logInfo('User automatically set to online on connect', { firebaseUid });
        startUserHeartbeat(io, firebaseUid);
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
          const uid = socket.data.firebaseUid as string | undefined;
          if (!uid) return;

          const auth = await assertCreatorOrAdminForPresenceLookup(uid);
          if (!auth.ok) {
            socket.emit('availability:batch', {});
            socket.emit('availability:batch:v2', {});
            return;
          }

          const rateLimit = await checkPresenceLookupRateLimit(socket.id);
          if (!rateLimit.allowed) {
            socket.emit('availability:batch', {});
            socket.emit('availability:batch:v2', {});
            return;
          }

          const normalized = normalizeCreatorIds(data);
          const firebaseUids = capPresenceLookupBatch(normalized.firebaseUids);
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

        const uid = socket.data.firebaseUid as string | undefined;
        if (!uid) return;

        const auth = await assertCreatorOrAdminForPresenceLookup(uid);
        if (!auth.ok) {
          socket.emit('user:availability:error', { error: auth.error });
          socket.emit('user:availability:batch', {});
          return;
        }

        const rateLimit = await checkPresenceLookupRateLimit(socket.id);
        if (!rateLimit.allowed) {
          socket.emit('user:availability:error', { error: 'RATE_LIMIT_EXCEEDED' });
          socket.emit('user:availability:batch', {});
          return;
        }

        const cappedUids = capPresenceLookupBatch(firebaseUids);
        const availability = await getBatchUserAvailability(cappedUids);
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
        const disconnectResult = await onCreatorDisconnect(uid, socket.id, getSocketVersion(socket));

        if (disconnectResult.isLastSocket) {
          lastCreatorHeartbeatAtMs.delete(uid);
          stopCreatorHeartbeat(uid);
          logDebug('Creator heartbeat stopped on disconnect', { firebaseUid: uid });

          if (await hasAnyConnectedSocket(io, uid, 'creator')) {
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
          logDebug('Creator device disconnected, but other devices still connected', {
            firebaseUid: uid,
            remainingDevices: disconnectResult.count,
          });
        }
      }

      // Handle user disconnect
      if (uid && isUser) {
        const disconnectResult = await onUserDisconnect(uid, socket.id, getSocketVersion(socket));

        if (disconnectResult.isLastSocket) {
          lastUserHeartbeatAtMs.delete(uid);
          stopUserHeartbeat(uid);
          logDebug('User heartbeat stopped on disconnect', { firebaseUid: uid });

          try {
            await setUserAvailability(uid, 'offline');
            io.to('creators').emit('user:status', { firebaseUid: uid, status: 'offline' });
            logInfo('User disconnected - automatically set to offline', { firebaseUid: uid });
          } catch (err) {
            logError('Failed to set user offline on disconnect', err, { firebaseUid: uid });
            io.to('creators').emit('user:status', { firebaseUid: uid, status: 'offline' });
          }
        } else {
          logDebug('User device disconnected, but other devices still connected', {
            firebaseUid: uid,
            remainingDevices: disconnectResult.count,
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
    await startCreatorHeartbeat(io, creatorFirebaseUid);
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
    const hasConnectedSocket = await hasAnyConnectedSocket(io, uid, 'creator');
    if (hasConnectedSocket) continue;
    await transitionCreatorPresence(io, uid, 'DISCONNECTED', 'availability.gateway.heartbeat_sweep');
    clearCreatorDisconnectTimer(uid);
    lastCreatorHeartbeatAtMs.delete(uid);
    cleanupLocalMapsForUid(uid, 'creator');
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
    const hasConnectedSocket = await hasAnyConnectedSocket(io, uid, 'user');
    if (hasConnectedSocket) continue;
    await setUserAvailability(uid, 'offline');
    io.to('creators').emit('user:status', { firebaseUid: uid, status: 'offline' });
    lastUserHeartbeatAtMs.delete(uid);
    cleanupLocalMapsForUid(uid, 'user');
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
