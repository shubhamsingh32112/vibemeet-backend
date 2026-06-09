import { Server, Socket } from 'socket.io';
import { recordCallMetric } from '../../utils/monitoring';
import {
  isPresenceRegistryShadow,
  shouldDualWriteRegistry,
  useRegistryAsAuthoritative,
} from './presence-registry-flags';
import * as registry from './presence-socket-registry.service';

export type PresenceSocketRole = registry.PresenceSocketRole;

export interface SocketTrackerResult {
  count: number;
  isFirstSocket: boolean;
  isLastSocket: boolean;
  socketVersion?: number;
}

const creatorSocketCounts = new Map<string, number>();
const userSocketCounts = new Map<string, number>();
const activeSocketsByCreator = new Map<string, Set<string>>();
const activeSocketsByUser = new Map<string, Set<string>>();

function incrementLocal(
  uid: string,
  socketId: string,
  role: PresenceSocketRole
): { count: number; isFirst: boolean } {
  const counts = role === 'creator' ? creatorSocketCounts : userSocketCounts;
  const activeMap = role === 'creator' ? activeSocketsByCreator : activeSocketsByUser;
  const current = counts.get(uid) ?? 0;
  counts.set(uid, current + 1);
  if (!activeMap.has(uid)) activeMap.set(uid, new Set());
  activeMap.get(uid)!.add(socketId);
  return { count: current + 1, isFirst: current === 0 };
}

function decrementLocal(
  uid: string,
  socketId: string,
  role: PresenceSocketRole
): { count: number; isLast: boolean } {
  const counts = role === 'creator' ? creatorSocketCounts : userSocketCounts;
  const activeMap = role === 'creator' ? activeSocketsByCreator : activeSocketsByUser;
  const sockets = activeMap.get(uid);
  if (sockets) {
    sockets.delete(socketId);
    if (sockets.size === 0) activeMap.delete(uid);
  }
  const current = counts.get(uid) ?? 0;
  const next = Math.max(current - 1, 0);
  if (next === 0) {
    counts.delete(uid);
  } else {
    counts.set(uid, next);
  }
  return { count: next, isLast: next === 0 };
}

function getLocalCount(uid: string, role: PresenceSocketRole): number {
  const counts = role === 'creator' ? creatorSocketCounts : userSocketCounts;
  return counts.get(uid) ?? 0;
}

function emitShadowMismatch(
  uid: string,
  role: PresenceSocketRole,
  op: string,
  local: number,
  redisCount: number
): void {
  if (!isPresenceRegistryShadow() || useRegistryAsAuthoritative()) return;
  recordCallMetric('presence.registry.shadow_mismatch', 1, {
    role,
    op,
    local: String(local),
    redis: String(redisCount),
    uid: uid.slice(0, 8),
  });
}

async function registryConnect(
  uid: string,
  socketId: string,
  role: PresenceSocketRole,
  local: SocketTrackerResult
): Promise<SocketTrackerResult> {
  if (!shouldDualWriteRegistry()) return local;
  const started = Date.now();
  const reg = await registry.registerSocket(uid, socketId, role);
  recordCallMetric('presence.registry.register', 1, { role });
  recordCallMetric('presence.registry.dual_write_latency_ms', Date.now() - started, {
    op: 'connect',
    role,
  });
  emitShadowMismatch(uid, role, 'connect', local.count, reg.count);
  if (useRegistryAsAuthoritative()) {
    return {
      count: reg.count,
      isFirstSocket: reg.isFirst,
      isLastSocket: false,
      socketVersion: reg.version,
    };
  }
  return { ...local, socketVersion: reg.version };
}

async function registryDisconnect(
  uid: string,
  socketId: string,
  role: PresenceSocketRole,
  version: number | undefined,
  local: SocketTrackerResult
): Promise<SocketTrackerResult> {
  if (!shouldDualWriteRegistry()) return local;
  const started = Date.now();
  const reg = await registry.unregisterSocket(uid, socketId, version ?? 0);
  recordCallMetric('presence.registry.unregister', 1, { role });
  recordCallMetric('presence.registry.dual_write_latency_ms', Date.now() - started, {
    op: 'disconnect',
    role,
  });
  emitShadowMismatch(uid, role, 'disconnect', local.count, reg.count);
  if (useRegistryAsAuthoritative()) {
    return {
      count: reg.count,
      isFirstSocket: false,
      isLastSocket: reg.count === 0,
      socketVersion: version,
    };
  }
  return local;
}

export async function onCreatorConnect(
  uid: string,
  socketId: string
): Promise<SocketTrackerResult> {
  const local = incrementLocal(uid, socketId, 'creator');
  return registryConnect(uid, socketId, 'creator', {
    count: local.count,
    isFirstSocket: local.isFirst,
    isLastSocket: false,
  });
}

export async function onCreatorDisconnect(
  uid: string,
  socketId: string,
  version?: number
): Promise<SocketTrackerResult> {
  const local = decrementLocal(uid, socketId, 'creator');
  return registryDisconnect(uid, socketId, 'creator', version, {
    count: local.count,
    isFirstSocket: false,
    isLastSocket: local.isLast,
  });
}

export async function onUserConnect(uid: string, socketId: string): Promise<SocketTrackerResult> {
  const local = incrementLocal(uid, socketId, 'user');
  return registryConnect(uid, socketId, 'user', {
    count: local.count,
    isFirstSocket: local.isFirst,
    isLastSocket: false,
  });
}

export async function onUserDisconnect(
  uid: string,
  socketId: string,
  version?: number
): Promise<SocketTrackerResult> {
  const local = decrementLocal(uid, socketId, 'user');
  return registryDisconnect(uid, socketId, 'user', version, {
    count: local.count,
    isFirstSocket: false,
    isLastSocket: local.isLast,
  });
}

export function localConnectedCheckOnThisNode(
  io: Server,
  uid: string,
  role: PresenceSocketRole
): boolean {
  const activeMap = role === 'creator' ? activeSocketsByCreator : activeSocketsByUser;
  const tracked = activeMap.get(uid);
  if (!tracked) return false;
  for (const socketId of tracked) {
    const socketInstance = io.sockets.sockets.get(socketId);
    if (!socketInstance?.connected) continue;
    if (role === 'creator' && !socketInstance.data.isCreator) continue;
    if (role === 'user' && !socketInstance.data.isUser) continue;
    if ((socketInstance.data.firebaseUid as string) === uid) return true;
  }
  return false;
}

export async function hasAnyConnectedSocket(
  io: Server,
  uid: string,
  role: PresenceSocketRole
): Promise<boolean> {
  if (useRegistryAsAuthoritative()) {
    if (await registry.hasAnySocket(uid)) return true;
    return localConnectedCheckOnThisNode(io, uid, role);
  }
  if (role === 'creator') {
    const tracked = activeSocketsByCreator.get(uid);
    if (tracked) {
      for (const socketId of tracked) {
        const s = io.sockets.sockets.get(socketId);
        if (s?.connected && (s.data.firebaseUid as string) === uid) return true;
      }
    }
    for (const [, s] of io.sockets.sockets) {
      if (
        s.connected &&
        (s.data.firebaseUid as string) === uid &&
        Boolean(s.data.isCreator)
      ) {
        return true;
      }
    }
    return false;
  }
  const tracked = activeSocketsByUser.get(uid);
  if (tracked) {
    for (const socketId of tracked) {
      const s = io.sockets.sockets.get(socketId);
      if (s?.connected && (s.data.firebaseUid as string) === uid) return true;
    }
  }
  return false;
}

export async function getTrackerSocketCount(
  uid: string,
  role: PresenceSocketRole
): Promise<number> {
  if (useRegistryAsAuthoritative()) {
    return registry.getSocketCount(uid);
  }
  return getLocalCount(uid, role);
}

export function cleanupLocalMapsForUid(uid: string, role: PresenceSocketRole): void {
  if (role === 'creator') {
    creatorSocketCounts.delete(uid);
    activeSocketsByCreator.delete(uid);
  } else {
    userSocketCounts.delete(uid);
    activeSocketsByUser.delete(uid);
  }
}

export function getActiveSocketIds(uid: string, role: PresenceSocketRole): Set<string> | undefined {
  const activeMap = role === 'creator' ? activeSocketsByCreator : activeSocketsByUser;
  return activeMap.get(uid);
}

export function listTrackedUids(role: PresenceSocketRole): string[] {
  const activeMap = role === 'creator' ? activeSocketsByCreator : activeSocketsByUser;
  return Array.from(activeMap.keys());
}

export function storeSocketVersion(socket: Socket, version: number): void {
  socket.data.presenceSocketVersion = version;
}

export function getSocketVersion(socket: Socket): number | undefined {
  return socket.data.presenceSocketVersion as number | undefined;
}

export { registry };
