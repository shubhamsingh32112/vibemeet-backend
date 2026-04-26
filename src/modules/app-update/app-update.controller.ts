import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { getIO } from '../../config/socket';
import { getRedis, isRedisConfigured } from '../../config/redis';
import { User } from '../user/user.model';
import { GlobalAppUpdate, GlobalAppUpdateAck } from './app-update.model';
import { logError, logInfo } from '../../utils/logger';

const ACTIVE_UPDATE_CACHE_KEY = 'app_update:active:v1';
const ACTIVE_UPDATE_CACHE_TTL_SECONDS = 60;
const APP_UPDATE_PUBLISH_IDEMPOTENCY_TTL_SECONDS = 90;

function toDto(update: any) {
  return {
    id: update._id.toString(),
    version: update.version,
    title: update.title,
    points: Array.isArray(update.points) ? update.points : [],
    updateUrl: update.updateUrl,
    isActive: update.isActive,
    publishedAt: update.publishedAt,
  };
}

function isValidHttpsUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function resolveAuthedUser(req: Request) {
  if (!req.auth?.firebaseUid) return null;
  return User.findOne({ firebaseUid: req.auth.firebaseUid }).select('_id role firebaseUid').lean();
}

function resolveFirebaseUid(req: Request): string | null {
  const uid = req.auth?.firebaseUid;
  if (!uid) return null;
  const s = String(uid).trim();
  return s.length > 0 ? s : null;
}

async function cacheActiveUpdate(update: unknown): Promise<void> {
  if (!isRedisConfigured()) return;
  try {
    const redis = getRedis();
    if (update == null) {
      await redis.del(ACTIVE_UPDATE_CACHE_KEY);
      return;
    }
    await redis.setex(
      ACTIVE_UPDATE_CACHE_KEY,
      ACTIVE_UPDATE_CACHE_TTL_SECONDS,
      JSON.stringify(update)
    );
  } catch (err) {
    logError('Failed to cache active app update', err);
  }
}

async function getActiveUpdateCached(): Promise<Record<string, any> | null> {
  if (!isRedisConfigured()) return null;
  try {
    const redis = getRedis();
    const raw = await redis.get(ACTIVE_UPDATE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, any>;
    if (!parsed || !parsed.id) return null;
    return parsed;
  } catch (err) {
    logError('Failed reading cached active app update', err);
    return null;
  }
}

async function reservePublishIdempotency(
  actorId: string,
  idempotencyKey: string
): Promise<boolean> {
  if (!isRedisConfigured()) return true;
  try {
    const redis = getRedis();
    const key = `app_update:publish:idempotency:${actorId}:${idempotencyKey}`;
    const result = await redis.set(
      key,
      '1',
      'EX',
      APP_UPDATE_PUBLISH_IDEMPOTENCY_TTL_SECONDS,
      'NX'
    );
    return result === 'OK';
  } catch (err) {
    logError('Failed to reserve app update publish idempotency key', err, {
      actorId,
    });
    // Fail open if Redis has transient issues.
    return true;
  }
}

export const publishGlobalAppUpdate = async (req: Request, res: Response): Promise<void> => {
  const startedAt = Date.now();
  try {
    const actor = await resolveAuthedUser(req);
    if (!actor || actor.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Forbidden: Admin access required' });
      return;
    }

    const title = String(req.body?.title ?? '').trim();
    const pointsRaw = Array.isArray(req.body?.points) ? req.body.points : [];
    const points = pointsRaw
      .map((p: unknown) => String(p ?? '').trim())
      .filter((point: string) => point.length > 0);
    const updateUrl = String(req.body?.updateUrl ?? '').trim();
    const idempotencyKey = String(req.headers['x-idempotency-key'] ?? '').trim();
    if (idempotencyKey) {
      const accepted = await reservePublishIdempotency(
        actor._id.toString(),
        idempotencyKey
      );
      if (!accepted) {
        res.status(409).json({
          success: false,
          error: 'Duplicate publish request detected. Please wait and retry.',
        });
        return;
      }
    }

    if (!title) {
      res.status(400).json({ success: false, error: 'Title is required' });
      return;
    }
    if (title.length > 160) {
      res.status(400).json({ success: false, error: 'Title is too long (max 160 chars)' });
      return;
    }
    if (points.length === 0) {
      res.status(400).json({ success: false, error: 'At least one update point is required' });
      return;
    }
    if (points.length > 12 || points.some((point: string) => point.length > 240)) {
      res.status(400).json({ success: false, error: 'Too many points or point text too long' });
      return;
    }
    if (!isValidHttpsUrl(updateUrl)) {
      res.status(400).json({ success: false, error: 'updateUrl must be a valid https URL' });
      return;
    }

    const now = new Date();
    const version = `${now.getTime()}`;
    const session = await mongoose.startSession();
    let created: any;
    try {
      await session.withTransaction(async () => {
        await GlobalAppUpdate.updateMany(
          { isActive: true },
          { $set: { isActive: false } },
          { session }
        );

        const docs = await GlobalAppUpdate.create(
          [
            {
              version,
              title,
              points,
              updateUrl,
              isActive: true,
              publishedAt: now,
              createdBy: actor._id,
            },
          ],
          { session }
        );
        created = docs[0];
      });
    } finally {
      await session.endSession();
    }

    if (!created) {
      res.status(500).json({ success: false, error: 'Failed to create active app update' });
      return;
    }

    const payload = toDto(created);
    await cacheActiveUpdate(payload);
    try {
      const io = getIO();
      const consumersRoomSize = io.sockets.adapter.rooms.get('consumers')?.size ?? 0;
      const creatorsRoomSize = io.sockets.adapter.rooms.get('creators')?.size ?? 0;
      io.to('consumers').emit('app_update:published', payload);
      io.to('creators').emit('app_update:published', payload);
      logInfo('Global app update socket broadcast emitted', {
        updateId: payload.id,
        consumersRoomSize,
        creatorsRoomSize,
      });
    } catch (emitErr) {
      logError('Failed to emit app_update:published event', emitErr, { updateId: payload.id });
    }

    logInfo('Global app update published', {
      updateId: payload.id,
      version: payload.version,
      adminUserId: actor._id.toString(),
      requestId: String(req.headers['x-request-id'] ?? ''),
      idempotencyKey,
      durationMs: Date.now() - startedAt,
    });

    res.status(201).json({ success: true, data: payload });
  } catch (error) {
    logError('Failed to publish global app update', error);
    res.status(500).json({ success: false, error: 'Failed to publish app update' });
  }
};

export const getCurrentGlobalAppUpdateForAdmin = async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = await resolveAuthedUser(req);
    if (!actor || actor.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Forbidden: Admin access required' });
      return;
    }
    const current = await GlobalAppUpdate.findOne({ isActive: true }).sort({ publishedAt: -1 }).lean();
    if (current) {
      await cacheActiveUpdate(toDto(current));
    } else {
      await cacheActiveUpdate(null);
    }
    res.status(200).json({
      success: true,
      data: current ? toDto(current) : null,
    });
  } catch (error) {
    logError('Failed to fetch current global app update for admin', error);
    res.status(500).json({ success: false, error: 'Failed to fetch app update' });
  }
};

export const getPendingGlobalAppUpdate = async (req: Request, res: Response): Promise<void> => {
  const startedAt = Date.now();
  try {
    const firebaseUid = resolveFirebaseUid(req);
    const actor = await resolveAuthedUser(req);
    if (!firebaseUid) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
    if (actor && actor.role !== 'user' && actor.role !== 'creator' && actor.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    const activeCached = await getActiveUpdateCached();
    let activeData: Record<string, any> | null = activeCached;

    if (!activeData) {
      const activeDb = await GlobalAppUpdate.findOne({ isActive: true }).sort({ publishedAt: -1 }).lean();
      if (!activeDb) {
        await cacheActiveUpdate(null);
        res.status(200).json({ success: true, data: null });
        return;
      }
      activeData = toDto(activeDb);
      await cacheActiveUpdate(activeData);
    }

    if (!activeData || !activeData.id) {
      res.status(200).json({ success: true, data: null });
      return;
    }

    // Critical: dedupe ACK across identity modes.
    // If the same Firebase identity later gets a Mongo User row, treat either ACK as sufficient.
    const ack = await GlobalAppUpdateAck.findOne({
      updateId: activeData.id,
      ackType: 'update_now_clicked',
      $or: [
        ...(actor?._id ? [{ userId: actor._id }] : []),
        { firebaseUid },
      ],
    })
      .select('_id')
      .lean();

    logInfo('Global app update pending lookup complete', {
      userId: actor?._id?.toString(),
      firebaseUid,
      cacheHit: Boolean(activeCached),
      hasAck: Boolean(ack),
      durationMs: Date.now() - startedAt,
    });

    res.status(200).json({
      success: true,
      data: ack ? null : activeData,
    });
  } catch (error) {
    logError('Failed to fetch pending global app update', error);
    res.status(500).json({ success: false, error: 'Failed to fetch pending update' });
  }
};

export const ackGlobalAppUpdateNow = async (req: Request, res: Response): Promise<void> => {
  try {
    const firebaseUid = resolveFirebaseUid(req);
    const actor = await resolveAuthedUser(req);
    if (!firebaseUid) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
    if (actor && actor.role !== 'user' && actor.role !== 'creator' && actor.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    const updateId = String(req.params.id || '').trim();
    if (!updateId) {
      res.status(400).json({ success: false, error: 'Update id is required' });
      return;
    }

    const update = await GlobalAppUpdate.findById(updateId).select('_id').lean();
    if (!update) {
      res.status(404).json({ success: false, error: 'Update not found' });
      return;
    }

    // Critical: idempotent across identity modes.
    // This prevents duplicate ACK rows when:
    // 1) a user ACKs before having a Mongo row (firebaseUid), then
    // 2) later gets a Mongo userId and ACKs again.
    const ackFilter: Record<string, any> = {
      updateId: update._id,
      ackType: 'update_now_clicked',
      $or: [
        ...(actor?._id ? [{ userId: actor._id }] : []),
        { firebaseUid },
      ],
    };

    // Insert the "canonical" ack shape when we have userId: store BOTH userId + firebaseUid.
    // This ensures future reads match regardless of which identifier is available.
    const ackInsert: Record<string, any> = {
      ackedAt: new Date(),
      firebaseUid,
      ...(actor?._id ? { userId: actor._id } : {}),
    };

    await GlobalAppUpdateAck.updateOne(
      ackFilter,
      {
        $setOnInsert: {
          ...ackInsert,
        },
      },
      {
        upsert: true,
      }
    );

    res.status(200).json({
      success: true,
      data: {
        updateId,
        ackType: 'update_now_clicked',
      },
    });
  } catch (error) {
    logError('Failed to ack app update', error);
    res.status(500).json({ success: false, error: 'Failed to acknowledge update' });
  }
};
