import type { Server as HttpServer } from 'http';
import { Server as SocketIOServer, type Server } from 'socket.io';
import Redis from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';
import { attachRedisClientMonitoring, isRedisConfigured } from '../config/redis';
import { setIO } from '../config/socket';
import { logInfo, logWarning } from '../utils/logger';

function socketAdapterFamily(): number | undefined {
  const rawFamily = process.env.REDIS_FAMILY;
  if (rawFamily === undefined || rawFamily === '') return undefined;
  const n = parseInt(rawFamily, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function createRedisPubClient(): Redis | null {
  const family = socketAdapterFamily();
  const redisUrl = process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL;
  if (redisUrl) {
    return new Redis(redisUrl, {
      ...(family !== undefined ? { family } : {}),
      maxRetriesPerRequest: 20,
      enableReadyCheck: true,
    });
  }
  if (process.env.REDISHOST) {
    return new Redis({
      host: process.env.REDISHOST,
      port: parseInt(process.env.REDISPORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || process.env.REDISPASSWORD,
      username: process.env.REDISUSER,
      ...(family !== undefined ? { family } : {}),
      maxRetriesPerRequest: 20,
      enableReadyCheck: true,
    });
  }
  return null;
}

export function attachSocketIoRedisAdapter(io: Server): void {
  if (!isRedisConfigured() || process.env.SOCKET_IO_REDIS_ADAPTER === 'false') {
    return;
  }
  try {
    const pubClient = createRedisPubClient();
    if (!pubClient) return;
    const subClient = pubClient.duplicate();
    attachRedisClientMonitoring(pubClient, 'socket_adapter_pub');
    attachRedisClientMonitoring(subClient, 'socket_adapter_sub');
    io.adapter(createAdapter(pubClient, subClient));
    logInfo('Socket.IO Redis adapter enabled (multi-node broadcasts)');
  } catch (adapterErr) {
    logWarning('Socket.IO Redis adapter failed — using in-memory adapter only', {
      error: adapterErr instanceof Error ? adapterErr.message : String(adapterErr),
    });
  }
}

export function initializeSocketIo(httpServer: HttpServer, socketCorsOrigin: ReturnType<typeof buildSocketCorsOrigin>): Server {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: socketCorsOrigin,
      methods: ['GET', 'POST'],
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
  });
  attachSocketIoRedisAdapter(io);
  setIO(io);
  return io;
}

export function buildSocketCorsOrigin(): boolean | string | RegExp | (string | RegExp)[] {
  const raw = (process.env.CORS_ORIGIN || '').trim();
  if (!raw || raw === '*') {
    if (process.env.NODE_ENV === 'production') {
      logWarning('CORS_ORIGIN is * or unset in production — set explicit origins for web clients', {});
    }
    return '*';
  }
  const escapeRegexLiteral = (input: string): string =>
    input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const corsOriginEntryToMatcher = (entry: string): string | RegExp => {
    const trimmed = entry.trim();
    if (!trimmed) return '*';
    if (trimmed === '*') return '*';
    if (trimmed.includes('*')) {
      const safe = escapeRegexLiteral(trimmed).replace(/\\\*/g, '.*');
      return new RegExp(`^${safe}$`);
    }
    return trimmed;
  };
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(corsOriginEntryToMatcher);
  if (parts.length === 0) return '*';
  if (parts.length === 1) return parts[0];
  return parts;
}

export function initializeHeadlessSocketIo(httpServer: HttpServer): Server {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: false },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
    allowRequest: (_req, callback) => {
      callback(null, false);
    },
  });
  attachSocketIoRedisAdapter(io);
  setIO(io);
  logInfo('Headless Socket.IO initialized for worker emits (no inbound connections)');
  return io;
}
