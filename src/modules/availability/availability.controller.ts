import type { Request } from 'express';
import type { Response } from 'express';
import { User } from '../user/user.model';
import { getAllOnlineUsers } from './user-availability.service';
import { logError } from '../../utils/logger';

const ONLINE_UID_CACHE_TTL_MS = 2000;
let cachedOnlineUids: string[] | null = null;
let cachedOnlineUidsAtMs = 0;

function parsePositiveInt(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

async function getOnlineUserUidsCached(): Promise<string[]> {
  const now = Date.now();
  if (cachedOnlineUids && now - cachedOnlineUidsAtMs < ONLINE_UID_CACHE_TTL_MS) {
    return cachedOnlineUids;
  }
  const uids = (await getAllOnlineUsers()).filter(Boolean);
  uids.sort();
  cachedOnlineUids = uids;
  cachedOnlineUidsAtMs = now;
  return uids;
}

export const getOnlineUsers = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const caller = await User.findOne({ firebaseUid: req.auth.firebaseUid })
      .select('role')
      .lean();
    const isCreator = caller?.role === 'creator' || caller?.role === 'admin';
    if (!isCreator) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    const limit = Math.min(2000, Math.max(1, parsePositiveInt(req.query.limit, 200)));
    const cursor = Math.max(0, parsePositiveInt(req.query.cursor, 0));

    const onlineFirebaseUids = await getOnlineUserUidsCached();

    const windowed = onlineFirebaseUids.slice(cursor, cursor + limit);
    const nextCursor = cursor + windowed.length;
    const hasMore = nextCursor < onlineFirebaseUids.length;

    if (windowed.length === 0) {
      res.json({
        success: true,
        data: {
          users: [],
          pagination: {
            cursor,
            limit,
            nextCursor: hasMore ? String(nextCursor) : null,
            hasMore,
            totalOnline: onlineFirebaseUids.length,
          },
        },
      });
      return;
    }

    const docs = await User.find({ firebaseUid: { $in: windowed } })
      .select('_id firebaseUid username avatar')
      .lean();

    const byUid = new Map(docs.map((u) => [u.firebaseUid, u] as const));
    const orderedUsers = windowed
      .map((uid) => byUid.get(uid))
      .filter((u): u is NonNullable<typeof u> => Boolean(u))
      .map((u) => ({
        id: u._id.toString(),
        firebaseUid: u.firebaseUid,
        username: u.username ?? null,
        avatar: u.avatar ?? null,
      }));

    res.json({
      success: true,
      data: {
        users: orderedUsers,
        pagination: {
          cursor,
          limit,
          nextCursor: hasMore ? String(nextCursor) : null,
          hasMore,
          totalOnline: onlineFirebaseUids.length,
        },
      },
    });
  } catch (error) {
    logError('❌ [AVAILABILITY] getOnlineUsers error', error, {});
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const resolveUsersByFirebaseUids = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const caller = await User.findOne({ firebaseUid: req.auth.firebaseUid })
      .select('role')
      .lean();
    const isCreator = caller?.role === 'creator' || caller?.role === 'admin';
    if (!isCreator) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    const firebaseUidsRaw = (req.body as any)?.firebaseUids;
    if (!Array.isArray(firebaseUidsRaw)) {
      res.status(400).json({ success: false, error: 'Invalid firebaseUids' });
      return;
    }

    const firebaseUids = Array.from(
      new Set(
        firebaseUidsRaw
          .filter((v: unknown): v is string => typeof v === 'string')
          .map((s) => s.trim())
          .filter(Boolean)
      )
    ).slice(0, 500);

    if (firebaseUids.length === 0) {
      res.json({ success: true, data: { users: [] } });
      return;
    }

    const docs = await User.find({ firebaseUid: { $in: firebaseUids } })
      .select('_id firebaseUid username avatar')
      .lean();

    const byUid = new Map(docs.map((u) => [u.firebaseUid, u] as const));
    const orderedUsers = firebaseUids
      .map((uid) => byUid.get(uid))
      .filter((u): u is NonNullable<typeof u> => Boolean(u))
      .map((u) => ({
        id: u._id.toString(),
        firebaseUid: u.firebaseUid,
        username: u.username ?? null,
        avatar: u.avatar ?? null,
      }));

    res.json({ success: true, data: { users: orderedUsers } });
  } catch (error) {
    logError('❌ [AVAILABILITY] resolveUsersByFirebaseUids error', error, {});
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

