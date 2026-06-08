import crypto from 'node:crypto';
import { getRedis, isRedisConfigured } from '../../config/redis';
import { logWarning } from '../../utils/logger';
import type { ContentClass, ProcessingStatus } from '../media-shared/types';

export interface StreamUploadSession {
  sessionId: string;
  userId: string;
  firebaseUid: string;
  contentClass: ContentClass;
  streamVideoId: string;
  processingStatus: ProcessingStatus;
  durationSeconds?: number;
  thumbnailValidated?: boolean;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

const KEY_PREFIX = 'stream:upload-session:';
const INDEX_KEY = 'stream:upload-session:index';
const DEFAULT_TTL_SECONDS = 2 * 60 * 60;

function sessionKey(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

function assertRedis(): void {
  if (!isRedisConfigured()) {
    throw new Error('stream upload sessions require Redis');
  }
}

export async function createStreamUploadSession(input: {
  userId: string;
  firebaseUid: string;
  contentClass: ContentClass;
  streamVideoId: string;
  ttlSeconds?: number;
}): Promise<StreamUploadSession> {
  assertRedis();
  const ttl = Math.max(300, input.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const sessionId = `vs_${crypto.randomBytes(16).toString('hex')}`;
  const now = Date.now();
  const session: StreamUploadSession = {
    sessionId,
    userId: input.userId,
    firebaseUid: input.firebaseUid,
    contentClass: input.contentClass,
    streamVideoId: input.streamVideoId,
    processingStatus: 'uploading',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + ttl * 1000,
  };
  const redis = getRedis();
  await redis
    .multi()
    .setex(sessionKey(sessionId), ttl, JSON.stringify(session))
    .zadd(INDEX_KEY, session.expiresAt, sessionId)
    .exec();
  return session;
}

export async function getStreamUploadSession(
  sessionId: string,
): Promise<StreamUploadSession | null> {
  assertRedis();
  if (!sessionId.startsWith('vs_')) return null;
  const raw = await getRedis().get(sessionKey(sessionId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StreamUploadSession;
  } catch {
    return null;
  }
}

export async function updateStreamUploadSession(
  session: StreamUploadSession,
): Promise<void> {
  assertRedis();
  session.updatedAt = Date.now();
  const ttl = Math.max(60, Math.ceil((session.expiresAt - Date.now()) / 1000));
  await getRedis().setex(sessionKey(session.sessionId), ttl, JSON.stringify(session));
}

export async function consumeStreamUploadSession(
  sessionId: string,
  userId: string,
  expectedClass: ContentClass,
): Promise<StreamUploadSession | null> {
  assertRedis();
  const session = await getStreamUploadSession(sessionId);
  if (!session) return null;
  if (session.userId !== userId) return null;
  if (session.contentClass !== expectedClass) return null;
  if (session.processingStatus !== 'ready') return null;
  await getRedis().del(sessionKey(sessionId));
  await getRedis().zrem(INDEX_KEY, sessionId);
  return session;
}

export async function findStreamSessionByVideoId(
  streamVideoId: string,
): Promise<StreamUploadSession | null> {
  assertRedis();
  const ids = await getRedis().zrange(INDEX_KEY, 0, -1);
  for (const id of ids) {
    const session = await getStreamUploadSession(id);
    if (session?.streamVideoId === streamVideoId) return session;
  }
  return null;
}

export async function listStaleStreamSessions(cutoffMs: number): Promise<StreamUploadSession[]> {
  assertRedis();
  const ids = await getRedis().zrangebyscore(INDEX_KEY, 0, cutoffMs);
  const out: StreamUploadSession[] = [];
  for (const id of ids) {
    const session = await getStreamUploadSession(id);
    if (session) out.push(session);
  }
  return out;
}

export async function markStreamSessionFailed(sessionId: string): Promise<void> {
  const session = await getStreamUploadSession(sessionId);
  if (!session) return;
  session.processingStatus = 'failed';
  await updateStreamUploadSession(session);
}

export async function deleteStreamUploadSession(sessionId: string): Promise<void> {
  assertRedis();
  await getRedis().del(sessionKey(sessionId));
  await getRedis().zrem(INDEX_KEY, sessionId);
}

export async function sweepStaleStreamSessions(): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const now = Date.now();
  const uploadingCutoff = now - 60 * 60 * 1000;
  const processingCutoff = now - 2 * 60 * 60 * 1000;
  let marked = 0;

  const ids = await getRedis().zrange(INDEX_KEY, 0, -1);
  for (const id of ids) {
    const session = await getStreamUploadSession(id);
    if (!session) continue;
    const staleUploading =
      session.processingStatus === 'uploading' && session.updatedAt < uploadingCutoff;
    const staleProcessing =
      session.processingStatus === 'processing' && session.updatedAt < processingCutoff;
    if (staleUploading || staleProcessing) {
      session.processingStatus = 'failed';
      await updateStreamUploadSession(session);
      marked++;
    }
  }
  if (marked > 0) {
    logWarning('Stream upload session sweeper marked stale sessions failed', { marked });
  }
  return marked;
}
