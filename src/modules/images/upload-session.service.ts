/**
 * Redis-backed upload sessions for direct-upload validation.
 *
 * Lifecycle:
 *   POST /images/direct-upload
 *     -> backend asks Cloudflare for an upload URL + imageId
 *     -> backend saves a session: { sessionId, userId, purpose, imageId, expiresAt }
 *     -> backend returns { uploadURL, imageId, sessionId, expiresAt } to client
 *   Client uploads bytes directly to Cloudflare using uploadURL.
 *   POST /images/commit { sessionId } (or the purpose-specific commit
 *     endpoint, e.g. /creator/profile/gallery/commit)
 *     -> backend reads session, MIME-sniffs bytes via Cloudflare, builds the
 *        IImageAsset, deletes the session (single-shot).
 *
 * If the client never commits, the orphan-cleanup worker removes the
 * Cloudflare image + the abandoned session after TTL.
 */

import crypto from 'node:crypto';
import { getRedis, isRedisConfigured } from '../../config/redis';
import { logWarning } from '../../utils/logger';
import { bumpImageCounter } from './image-metrics';

export type UploadPurpose =
  | 'creator-avatar'
  | 'creator-gallery'
  | 'user-avatar'
  | 'admin-moderation';

export interface UploadSession {
  sessionId: string;
  userId: string;
  purpose: UploadPurpose;
  imageId: string;
  createdAt: number;
  expiresAt: number;
  /** Optional client hint about declared bytes (server still MIME-sniffs). */
  declaredSizeBytes?: number;
}

const KEY_PREFIX = 'image:upload-session:';
const DEFAULT_TTL_SECONDS = 30 * 60; // 30 minutes
const CLEANUP_INDEX_KEY = 'image:upload-session:index';

function sessionKey(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

function assertRedis(): void {
  if (!isRedisConfigured()) {
    throw new Error('upload-session service requires Redis');
  }
}

export interface CreateSessionInput {
  userId: string;
  purpose: UploadPurpose;
  imageId: string;
  declaredSizeBytes?: number;
  ttlSeconds?: number;
}

export async function createSession(input: CreateSessionInput): Promise<UploadSession> {
  assertRedis();
  const ttl = Math.max(60, input.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const sessionId = `s_${crypto.randomBytes(16).toString('hex')}`;
  const now = Date.now();
  const session: UploadSession = {
    sessionId,
    userId: input.userId,
    purpose: input.purpose,
    imageId: input.imageId,
    createdAt: now,
    expiresAt: now + ttl * 1000,
    declaredSizeBytes: input.declaredSizeBytes,
  };
  const redis = getRedis();
  await redis
    .multi()
    .setex(sessionKey(sessionId), ttl, JSON.stringify(session))
    // Index for orphan-cleanup sweep (score = expiresAt ms).
    .zadd(CLEANUP_INDEX_KEY, session.expiresAt, sessionId)
    .exec();
  bumpImageCounter('upload_session.created', { purpose: input.purpose });
  return session;
}

export async function getSession(sessionId: string): Promise<UploadSession | null> {
  assertRedis();
  if (!sessionId.startsWith('s_')) return null;
  const raw = await getRedis().get(sessionKey(sessionId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UploadSession;
  } catch (error) {
    logWarning('upload-session JSON parse failed', { sessionId, error: (error as Error).message });
    return null;
  }
}

/** Atomically consume a session — used by commit. */
export async function consumeSession(
  sessionId: string,
  userId: string,
  purpose: UploadPurpose,
): Promise<UploadSession | null> {
  assertRedis();
  const session = await getSession(sessionId);
  if (!session) {
    bumpImageCounter('upload_session.consume_missing');
    return null;
  }
  if (session.userId !== userId) {
    bumpImageCounter('upload_session.consume_owner_mismatch');
    return null;
  }
  if (session.purpose !== purpose) {
    bumpImageCounter('upload_session.consume_purpose_mismatch', { expected: purpose, actual: session.purpose });
    return null;
  }
  const redis = getRedis();
  const deleted = await redis.del(sessionKey(sessionId));
  await redis.zrem(CLEANUP_INDEX_KEY, sessionId);
  if (!deleted) {
    bumpImageCounter('upload_session.consume_race');
    return null;
  }
  bumpImageCounter('upload_session.consumed', { purpose });
  return session;
}

/**
 * Returns sessions whose TTL is expired but the index hasn't reaped them yet.
 * The orphan-cleanup worker iterates these and deletes the Cloudflare image.
 */
export async function listExpiredSessions(limit: number = 100): Promise<UploadSession[]> {
  assertRedis();
  const now = Date.now();
  const redis = getRedis();
  const ids = await redis.zrangebyscore(CLEANUP_INDEX_KEY, '-inf', now, 'LIMIT', 0, limit);
  if (ids.length === 0) return [];
  const pipeline = redis.multi();
  for (const id of ids) pipeline.get(sessionKey(id));
  const results = await pipeline.exec();
  const sessions: UploadSession[] = [];
  for (let i = 0; i < ids.length; i++) {
    const raw = results?.[i]?.[1] as string | null;
    if (raw) {
      try {
        sessions.push(JSON.parse(raw) as UploadSession);
      } catch {
        // index entry without payload -> sweep below
      }
    } else {
      // Stale index entry — purge.
      await redis.zrem(CLEANUP_INDEX_KEY, ids[i]);
    }
  }
  return sessions;
}

export async function removeSessionFromIndex(sessionId: string): Promise<void> {
  if (!isRedisConfigured()) return;
  await getRedis().zrem(CLEANUP_INDEX_KEY, sessionId);
  await getRedis().del(sessionKey(sessionId));
}
