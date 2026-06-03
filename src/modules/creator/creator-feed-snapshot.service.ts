import { Creator, type ICreator } from './creator.model';
import { getBatchCreatorPresence } from '../availability/presence.service';
import { serializeCreatorImages } from '../images/creator-image-helpers';
import {
  CREATOR_CARD_TTL,
  creatorCardCacheKey,
  isRedisConfigured,
} from '../../config/redis';
import { safeRedisGet, safeRedisSet } from '../../utils/redis-circuit-breaker';
import { logError } from '../../utils/logger';

/** Card payload for fan home grid + creator:status socket insertion. */
export type CreatorFeedCardSnapshot = {
  id: string;
  userId: string | null;
  firebaseUid: string;
  name: string;
  avatar?: ReturnType<typeof import('../images/serialize-image-asset').serializeAvatar>;
  price: number;
  age?: number;
  location?: string;
  categories: string[];
  availability: 'online' | 'on_call' | 'offline';
  about: string;
  galleryImages: unknown[];
  isFavorite: boolean;
};

const FEED_SELECT =
  '_id userId firebaseUid name photo avatar price age location categories createdAt updatedAt';

function buildSnapshotFromCreator(
  creator: {
    _id: { toString(): string };
    userId?: { toString(): string } | null;
    firebaseUid?: string | null;
    name: string;
    price: number;
    age?: number;
    location?: string;
    categories?: string[];
  },
  availability: 'online' | 'on_call' | 'offline',
): CreatorFeedCardSnapshot | null {
  const firebaseUid =
    creator.firebaseUid && String(creator.firebaseUid).trim() !== ''
      ? String(creator.firebaseUid).trim()
      : null;
  if (!firebaseUid) return null;

  const avatar = serializeCreatorImages(creator as unknown as ICreator).avatar;
  return {
    id: creator._id.toString(),
    userId: creator.userId ? creator.userId.toString() : null,
    firebaseUid,
    name: creator.name,
    avatar,
    price: creator.price,
    age: creator.age,
    location: creator.location,
    categories: creator.categories || [],
    availability,
    about: '',
    galleryImages: [],
    isFavorite: false,
  };
}

export async function cacheCreatorFeedCardSnapshot(
  snapshot: CreatorFeedCardSnapshot,
): Promise<void> {
  if (!isRedisConfigured()) return;
  try {
    await safeRedisSet(creatorCardCacheKey(snapshot.firebaseUid), JSON.stringify(snapshot), {
      ex: CREATOR_CARD_TTL,
    });
  } catch (err) {
    logError('creator.card_cache_write_failed', err, { firebaseUid: snapshot.firebaseUid });
  }
}

export async function getCreatorFeedCardSnapshot(
  firebaseUid: string,
  options?: { availability?: 'online' | 'on_call' | 'offline' },
): Promise<CreatorFeedCardSnapshot | null> {
  const uid = firebaseUid.trim();
  if (!uid) return null;

  if (isRedisConfigured()) {
    try {
      const cached = await safeRedisGet<CreatorFeedCardSnapshot>(creatorCardCacheKey(uid));
      if (cached?.id && cached.firebaseUid === uid) {
        if (options?.availability) {
          return { ...cached, availability: options.availability };
        }
        return cached;
      }
    } catch {
      // fall through to Mongo
    }
  }

  const creator = await Creator.findOne({ firebaseUid: uid }).select(FEED_SELECT).lean();
  if (!creator) return null;

  const presenceMap = await getBatchCreatorPresence([uid]);
  const availability = options?.availability ?? presenceMap[uid]?.state ?? 'offline';
  const snapshot = buildSnapshotFromCreator(creator, availability);
  if (snapshot) {
    await cacheCreatorFeedCardSnapshot(snapshot);
  }
  return snapshot;
}
