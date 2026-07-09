import type { Request } from 'express';
import { Response } from 'express';
import mongoose from 'mongoose';
import { Creator, type ICreator, CREATOR_LISTABLE_FILTER } from './creator.model';
import { ACTIVE_WITHDRAWAL_STATUSES, MIN_CREATOR_WITHDRAWAL_COINS } from './creator-withdrawal.constants';
import { User } from '../user/user.model';
import { CreatorTaskProgress, ICreatorTaskProgress } from './creator-task.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { CallHistory } from '../billing/call-history.model';
import { CREATOR_TASKS, getTaskByKey, isValidTaskKey, getDailyPeriodBounds } from './creator-tasks.config';
import { getIO } from '../../config/socket';
import { transitionCreatorPresence } from '../availability/presence.service';
import { emitCreatorDataUpdated } from './creator-notify';
import { applyCreatorAvailabilityIntent } from '../availability/availability.gateway';
import { getOnlineTodaySecondsLive } from '../availability/creator-daily-online.service';
import { getBatchCreatorPresence, normalizeFirebaseUids } from '../availability/presence.service';
import {
  addCreatorFirebaseUidToCache,
  getCreatorFirebaseUidsCached,
  removeCreatorFirebaseUidFromCache,
} from './creator-uids-cache.service';
import {
  getAvailabilityFeedPageFromRank,
  recordFeedRankShadowMismatchIfNeeded,
  removeCreatorFromFeedRank,
} from './creator-feed-rank.service';
import {
  getRedis,
  creatorDashboardKey,
  CREATOR_DASHBOARD_TTL,
  invalidateCreatorDashboard,
  invalidateAdminCaches,
  creatorTasksKey,
  CREATOR_TASKS_TTL,
  invalidateCreatorTasks,
  isRedisConfigured,
  creatorFeedCacheKey,
  creatorDetailCacheKey,
  CREATOR_FEED_TTL,
  CREATOR_DETAIL_TTL,
  registerCreatorFeedCacheKey,
  registerCreatorDetailCacheKey,
  invalidateCreatorCatalogCaches,
  invalidateCreatorDetailCache,
  bumpCreatorFeedCacheMetric,
} from '../../config/redis';
import { safeRedisGet, safeRedisSet } from '../../utils/redis-circuit-breaker';
import { verifyUserBalance } from '../../utils/balance-integrity';
import { getCanonicalCoinsAndRepairIfNeeded } from '../../utils/ledger-coins';
import { Withdrawal } from './withdrawal.model';
import { emitToAdmin } from '../admin/admin.gateway';
import { assertAdminOrOwningAgentForCreator } from '../../middlewares/staff.middleware';
import {
  CREATOR_GALLERY_MAX_IMAGES,
  CREATOR_GALLERY_MIN_IMAGES,
} from './creator-gallery.constants';
import { logError, logInfo, logWarning } from '../../utils/logger';
import { recordCallMetric, recordFeedMetric } from '../../utils/monitoring';
import { ensureCreatorPromotionWalletClearedEntry } from './creator-starter.service';
import { ensureStreamUser } from '../../config/stream';
import { getStreamUpsertPayload } from '../../utils/stream-user-payload';
import { invalidateOtherMemberCacheForFirebaseUid } from '../chat/chat-cache-invalidation';
import { validateCreatorPriceForApi } from '../../config/creator-price.config';
import { invalidateCreatorPricingCache } from '../video/pricing.service';
import { CREATOR_SHARE_PERCENTAGE } from '../../config/pricing.config';
import {
  parseCreatorLocationForCreate,
  parseCreatorLocationForUpdate,
} from './creator-location.util';
import {
  commitImageAsset,
  CommitImageAssetError,
} from '../images/commit-image-asset';
import {
  CloudflareImagesCircuitOpenError,
  CloudflareImagesError,
} from '../images/cloudflare.client';
import {
  safeCloudflareImagesClientError,
  setDegradedHeader,
} from '../images/images.controller';
import { isCloudflareImagesEnabled } from '../../config/cloudflare';
import {
  serializeCreatorImages,
  serializeCreatorGallery,
} from '../images/creator-image-helpers';
import {
  cacheCreatorFeedCardSnapshot,
  type CreatorFeedCardSnapshot,
} from './creator-feed-snapshot.service';
import { isAgencyRole, isBdRole, isSuperAdminRole } from '../../utils/staff-roles';
import { isMomentsEnabled } from '../../config/moments';
import { CreatorMoment } from '../moments/models/creator-moment.model';
import { MomentRevenue } from '../moments/models/moment-revenue.model';

/** Bump when feed Redis JSON shape changes so stale entries are ignored. */
const CREATOR_FEED_CACHE_VERSION = 3;

type CreatorFeedSortMode = 'createdAt' | 'availability';

function parseCreatorFeedSort(raw: unknown): CreatorFeedSortMode {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s === 'availability' ? 'availability' : 'createdAt';
}

function availabilityRank(state: 'online' | 'on_call' | 'offline' | undefined): number {
  if (state === 'online') return 0;
  if (state === 'on_call') return 1;
  return 2;
}

/** Legacy root catalog removed — clients must use GET /creator/feed. */
export const getCreatorCatalogGone = async (_req: Request, res: Response): Promise<void> => {
  res.status(410).json({
    success: false,
    code: 'ENDPOINT_REMOVED',
    error: 'This endpoint was removed. Use GET /creator/feed for the paginated catalog.',
  });
};

type CreatorFeedBaseRow = {
  id: string;
  userId: string | null;
  firebaseUid: string | null;
  name: string;
  /** @deprecated Legacy Firebase photo URL. Phase 3+ ships `avatar` (AvatarUrls). */
  photo?: string;
  /** Cloudflare-Images serialized avatar (Phase 3+). */
  avatar?: ReturnType<typeof import('../images/serialize-image-asset').serializeAvatar>;
  price: number;
  age?: number;
  location?: string;
  categories: string[];
  isOnline: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/** Paginated lightweight catalog: no gallery, no Storage I/O, optional Redis cache. */
export const getCreatorFeed = async (req: Request, res: Response): Promise<void> => {
  const t0 = Date.now();
  let mongoMs = 0;
  let availabilityMs = 0;
  let cacheHit = false;
  let missingCreatorFirebaseUidCount = 0;
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (currentUser?.role === 'creator') {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Creators cannot view other creators. Use /user/list to view users.',
      });
      return;
    }
    if (isBdRole(currentUser?.role)) {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Use GET /agency/creators for your assigned creators.',
      });
      return;
    }
    if (isAgencyRole(currentUser?.role)) {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Use the agency dashboard for creator lists.',
      });
      return;
    }

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const skip = (page - 1) * limit;
    const feedSort = parseCreatorFeedSort(req.query.sort);
    const canCacheFeed = feedSort === 'createdAt';
    const cacheKey = creatorFeedCacheKey(page, limit, feedSort);

    const favoriteSet =
      currentUser && currentUser.role === 'user'
        ? new Set((currentUser.favoriteCreatorIds || []).map((id) => id.toString()))
        : new Set<string>();

    let baseRows: CreatorFeedBaseRow[] = [];
    let total = 0;

    if (canCacheFeed && isRedisConfigured()) {
      const cached = await safeRedisGet<{ v: number; creators: CreatorFeedBaseRow[]; total: number }>(
        cacheKey,
      );
      if (
        cached?.creators &&
        typeof cached.total === 'number' &&
        cached.v === CREATOR_FEED_CACHE_VERSION
      ) {
        cacheHit = true;
        baseRows = cached.creators;
        total = cached.total;
        await bumpCreatorFeedCacheMetric('hit');
      } else {
        await bumpCreatorFeedCacheMetric('miss');
      }
    }

    if (!cacheHit) {
      const tMongo = Date.now();
      const allowFallbackJoin = process.env.ENABLE_CREATOR_UID_FALLBACK_JOIN === 'true';
      const feedSelect =
        '_id userId firebaseUid name photo avatar price age location isOnline categories createdAt updatedAt';

      if (feedSort === 'availability') {
        const tAvailSort = Date.now();
        let pageIds: mongoose.Types.ObjectId[] = [];
        let firebaseUidByUserId = new Map<string, string | null>();
        const rankPage = await getAvailabilityFeedPageFromRank(skip, limit);

        const buildLegacyAvailabilityPage = async (): Promise<mongoose.Types.ObjectId[]> => {
          const minimal = await Creator.find(CREATOR_LISTABLE_FILTER)
            .select('_id userId firebaseUid createdAt')
            .lean();
          total = minimal.length;

          if (total > 5000) {
            logWarning('creator.feed.availability_sort_large_catalog', {
              count: total,
              page,
              limit,
            });
          }

          const missingUidUserIds = allowFallbackJoin
            ? minimal
                .filter((c) => !c.firebaseUid || String(c.firebaseUid).trim() === '')
                .map((c) => c.userId)
                .filter((id): id is mongoose.Types.ObjectId => Boolean(id))
            : [];
          const linkedUsers =
            allowFallbackJoin && missingUidUserIds.length
              ? await User.find({ _id: { $in: missingUidUserIds } }).select('_id firebaseUid').lean()
              : [];
          firebaseUidByUserId = new Map(
            linkedUsers.map((u) => [u._id.toString(), u.firebaseUid || null] as const),
          );

          type RankRow = {
            id: mongoose.Types.ObjectId;
            firebaseUid: string | null;
            createdAt: Date;
          };
          const rankRows: RankRow[] = minimal.map((c) => {
            const firebaseUid =
              c.firebaseUid && String(c.firebaseUid).trim() !== ''
                ? String(c.firebaseUid).trim()
                : allowFallbackJoin && c.userId
                  ? (firebaseUidByUserId.get(c.userId.toString()) ?? null)
                  : null;
            if (!firebaseUid) missingCreatorFirebaseUidCount += 1;
            return { id: c._id, firebaseUid, createdAt: c.createdAt };
          });

          const normalized = normalizeFirebaseUids(
            rankRows.map((r) => r.firebaseUid).filter((uid): uid is string => uid !== null),
          );
          const presenceMap =
            normalized.firebaseUids.length > 0
              ? await getBatchCreatorPresence(normalized.firebaseUids)
              : {};

          rankRows.sort((a, b) => {
            const aState = a.firebaseUid ? presenceMap[a.firebaseUid]?.state : 'offline';
            const bState = b.firebaseUid ? presenceMap[b.firebaseUid]?.state : 'offline';
            const rankDiff = availabilityRank(aState) - availabilityRank(bState);
            if (rankDiff !== 0) return rankDiff;
            return b.createdAt.getTime() - a.createdAt.getTime();
          });

          return rankRows.slice(skip, skip + limit).map((r) => r.id);
        };

        if (rankPage && rankPage.pageIds.length > 0) {
          total = rankPage.total;
          pageIds = rankPage.pageIds;
          if (process.env.CREATOR_FEED_RANK_SHADOW === 'true') {
            const rankTotal = total;
            const legacyIds = await buildLegacyAvailabilityPage();
            total = rankTotal;
            await recordFeedRankShadowMismatchIfNeeded(
              legacyIds.map((id) => id.toString()),
              pageIds.map((id) => id.toString()),
            );
          }
        } else {
          pageIds = await buildLegacyAvailabilityPage();
        }

        const creators =
          pageIds.length > 0
            ? await Creator.find({ _id: { $in: pageIds } }).select(feedSelect).lean()
            : [];
        const creatorById = new Map(creators.map((c) => [c._id.toString(), c]));

        if (allowFallbackJoin && firebaseUidByUserId.size === 0) {
          const missingUidUserIds = creators
            .filter((c) => !c.firebaseUid || String(c.firebaseUid).trim() === '')
            .map((c) => c.userId)
            .filter((id): id is mongoose.Types.ObjectId => Boolean(id));
          if (missingUidUserIds.length) {
            const linkedUsers = await User.find({ _id: { $in: missingUidUserIds } })
              .select('_id firebaseUid')
              .lean();
            firebaseUidByUserId = new Map(
              linkedUsers.map((u) => [u._id.toString(), u.firebaseUid || null] as const),
            );
          }
        }

        const availSortMs = Date.now() - tAvailSort;
        recordFeedMetric('creator_feed_availability_sort_ms', availSortMs, {
          page: String(page),
          limit: String(limit),
        });
        recordFeedMetric('creator_feed_availability_sort_count', 1, {
          page: String(page),
          limit: String(limit),
        });
        recordFeedMetric('creator_feed_availability_sort_total_creators', total, {
          page: String(page),
          limit: String(limit),
        });

        baseRows = pageIds
          .map((id) => creatorById.get(id.toString()))
          .filter((c): c is NonNullable<typeof c> => Boolean(c))
          .map((creator) => {
            const avatar = serializeCreatorImages(creator as unknown as ICreator).avatar;
            return {
              id: creator._id.toString(),
              userId: creator.userId ? creator.userId.toString() : null,
              firebaseUid:
                creator.firebaseUid && String(creator.firebaseUid).trim() !== ''
                  ? String(creator.firebaseUid).trim()
                  : allowFallbackJoin && creator.userId
                    ? (firebaseUidByUserId.get(creator.userId.toString()) ?? null)
                    : null,
              name: creator.name,
              avatar,
              price: creator.price,
              age: creator.age,
              location: creator.location,
              categories: creator.categories || [],
              isOnline: creator.isOnline,
              createdAt: creator.createdAt,
              updatedAt: creator.updatedAt,
            };
          });
      } else {
        const [creators, count] = await Promise.all([
          Creator.find(CREATOR_LISTABLE_FILTER)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .select(feedSelect)
            .lean(),
          Creator.countDocuments({}),
        ]);
        total = count;

        for (const c of creators) {
          if (!c.firebaseUid || String(c.firebaseUid).trim() === '') {
            missingCreatorFirebaseUidCount += 1;
          }
        }

        const missingUidUserIds = allowFallbackJoin
          ? creators
              .filter((c) => !c.firebaseUid || String(c.firebaseUid).trim() === '')
              .map((c) => c.userId)
              .filter((id): id is mongoose.Types.ObjectId => Boolean(id))
          : [];
        const linkedUsers =
          allowFallbackJoin && missingUidUserIds.length
            ? await User.find({ _id: { $in: missingUidUserIds } }).select('_id firebaseUid').lean()
            : [];
        const firebaseUidByUserId = new Map(
          linkedUsers.map((u) => [u._id.toString(), u.firebaseUid || null] as const),
        );

        if (missingCreatorFirebaseUidCount > 0) {
          logError('creator.uid.fallback.used', new Error('creator firebaseUid missing'), {
            endpoint: 'GET /creator/feed',
            page,
            limit,
            allowFallbackJoin,
            missingCount: missingCreatorFirebaseUidCount,
          });
        }

        baseRows = creators.map((creator) => {
          const avatar = serializeCreatorImages(creator as unknown as ICreator).avatar;
          return {
            id: creator._id.toString(),
            userId: creator.userId ? creator.userId.toString() : null,
            firebaseUid:
              creator.firebaseUid && String(creator.firebaseUid).trim() !== ''
                ? String(creator.firebaseUid).trim()
                : allowFallbackJoin && creator.userId
                  ? (firebaseUidByUserId.get(creator.userId.toString()) ?? null)
                  : null,
            name: creator.name,
            avatar,
            price: creator.price,
            age: creator.age,
            location: creator.location,
            categories: creator.categories || [],
            isOnline: creator.isOnline,
            createdAt: creator.createdAt,
            updatedAt: creator.updatedAt,
          };
        });

        if (canCacheFeed && isRedisConfigured()) {
          const payload = JSON.stringify({
            v: CREATOR_FEED_CACHE_VERSION,
            creators: baseRows,
            total,
          });
          await safeRedisSet(cacheKey, payload, { ex: CREATOR_FEED_TTL });
          await registerCreatorFeedCacheKey(cacheKey);
        }
      }

      mongoMs = Date.now() - tMongo;
    } else {
      mongoMs = Date.now() - t0;
    }

    const tAvail = Date.now();
    const normalizedFeedUids = normalizeFirebaseUids(
      baseRows.map((c) => c.firebaseUid).filter((uid): uid is string => uid !== null)
    );
    if (normalizedFeedUids.invalidUids.length > 0) {
      const validCount = normalizedFeedUids.firebaseUids.length;
      const totalInput = validCount + normalizedFeedUids.invalidUids.length;
      logWarning('creator.feed.uid_contract_violation', {
        count: normalizedFeedUids.invalidUids.length,
        validCount,
        sample: normalizedFeedUids.invalidUids.slice(0, 3),
      });
      recordCallMetric('presence.creator_uid_contract_violation', normalizedFeedUids.invalidUids.length, {
        context: 'creator_feed',
      });
      recordCallMetric(
        'presence.creator_uid_contract_violation_rate',
        normalizedFeedUids.invalidUids.length / Math.max(totalInput, 1),
        { context: 'creator_feed' }
      );
      recordCallMetric('presence.creator_uid_contract_input_size', totalInput, { context: 'creator_feed' });
    }
    const firebaseUids = normalizedFeedUids.firebaseUids;
    const presenceMap = firebaseUids.length > 0 ? await getBatchCreatorPresence(firebaseUids) : {};
    const availabilityMap: Record<string, 'online' | 'on_call' | 'offline'> = {};
    Object.entries(presenceMap).forEach(([uid, record]) => {
      availabilityMap[uid] = record.state;
    });
    availabilityMs = Date.now() - tAvail;

    const creatorsOut = baseRows.map((c) => {
      const availability = c.firebaseUid
        ? (availabilityMap[c.firebaseUid] ?? 'offline')
        : 'offline';
      return {
        ...c,
        about: '',
        galleryImages: [] as unknown[],
        isFavorite: favoriteSet.has(c.id),
        availability,
      };
    });

    for (const row of creatorsOut) {
      if (!row.firebaseUid) continue;
      const snapshot: CreatorFeedCardSnapshot = {
        id: row.id,
        userId: row.userId,
        firebaseUid: row.firebaseUid,
        name: row.name,
        avatar: row.avatar,
        price: row.price,
        age: row.age,
        location: row.location,
        categories: row.categories,
        availability: row.availability,
        about: '',
        galleryImages: [],
        isFavorite: favoriteSet.has(row.id),
      };
      cacheCreatorFeedCardSnapshot(snapshot).catch(() => {});
    }

    logInfo('creator.feed.timing', {
      page,
      limit,
      sort: feedSort,
      cacheHit,
      mongoMs,
      availabilityMs,
      missingCreatorFirebaseUidCount,
      totalMs: Date.now() - t0,
      rowCount: creatorsOut.length,
    });
    const sampled = creatorsOut
      .filter((c) => typeof c.firebaseUid === 'string' && Boolean(c.firebaseUid))
      .slice(0, 5)
      .map((creator) => {
        const firebaseUid = creator.firebaseUid as string;
        const record = presenceMap[firebaseUid];
        const updatedAt = Number(record?.updatedAt) || Date.now();
        return {
          creatorId: creator.id,
          firebaseUid,
          presenceSource: record?.source ?? 'missing',
          availability: availabilityMap[firebaseUid] ?? 'offline',
          cacheHit,
          presenceAgeMs: Math.max(0, Date.now() - updatedAt),
        };
      });
    if (sampled.length > 0) {
      logInfo('creator.feed.presence_diagnostics', {
        page,
        limit,
        sampled,
      });
    }

    logInfo('feed.query.count', {
      mongoQueries: cacheHit ? 0 : 1,
      redisOps: isRedisConfigured() ? 1 : 0,
      allowFallbackJoin: process.env.ENABLE_CREATOR_UID_FALLBACK_JOIN === 'true',
    });

    res.json({
      success: true,
      data: {
        creators: creatorsOut,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    logError('Get creator feed error', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/** All linked creator Firebase UIDs for presence hydration (tiny payload, cached). */
export const getCreatorFirebaseUids = async (req: Request, res: Response): Promise<void> => {
  const t0 = Date.now();
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (currentUser?.role === 'creator') {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Creators cannot use this endpoint.',
      });
      return;
    }
    if (isBdRole(currentUser?.role)) {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Use agent endpoints for assigned creators.',
      });
      return;
    }

    const { firebaseUids, cacheHit } = await getCreatorFirebaseUidsCached();

    logInfo('creator.uids.timing', {
      cacheHit,
      totalMs: Date.now() - t0,
      count: firebaseUids.length,
    });
    res.json({ success: true, data: { firebaseUids } });
  } catch (error) {
    logError('Get creator firebase UIDs error', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/** O(1) creator lookup for incoming-call flows. */
export const getCreatorByFirebaseUid = async (req: Request, res: Response): Promise<void> => {
  const t0 = Date.now();
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const uidRaw = String(req.params.uid ?? '').trim();
    if (!uidRaw) {
      res.status(400).json({ success: false, error: 'uid is required' });
      return;
    }

    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    // Allow creators to look up *themselves* (needed for creator-initiated call flow
    // to resolve their own Creator._id). Still deny looking up other creators.
    if (currentUser?.role === 'creator' && req.auth.firebaseUid !== uidRaw) {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Creators cannot view other creators.',
      });
      return;
    }
    if (isBdRole(currentUser?.role)) {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Use agent endpoints for your assigned creators.',
      });
      return;
    }

    const creator = await Creator.findOne({ firebaseUid: uidRaw })
      .select(
        '_id userId firebaseUid name photo avatar price age location categories createdAt updatedAt',
      )
      .lean();
    if (!creator) {
      res.status(404).json({ success: false, error: 'Creator not found' });
      return;
    }

    const presenceMap = await getBatchCreatorPresence([uidRaw]);
    const availability = presenceMap[uidRaw]?.state ?? 'offline';
    const images = serializeCreatorImages(creator as unknown as ICreator);
    const legacyPhoto =
      (creator as unknown as { photo?: string | null }).photo ?? null;
    const avatarUrls = images.avatar?.avatarUrls;
    const hasCallPhoto =
      typeof avatarUrls?.callPhoto === 'string' &&
      avatarUrls.callPhoto.trim().length > 0;
    const hasMd =
      typeof avatarUrls?.md === 'string' && avatarUrls.md.trim().length > 0;
    const hasAnyAvatar = hasCallPhoto || hasMd || Boolean(legacyPhoto);
    if (!hasAnyAvatar) {
      logError('creator.by_uid.avatar_missing', new Error('creator avatar missing'), {
        endpoint: 'GET /creator/by-firebase-uid/:uid',
        firebaseUid: uidRaw,
        creatorId: creator._id.toString(),
        availability,
        hasCallPhoto,
        hasMd,
        hasLegacyPhoto: Boolean(legacyPhoto),
      });
    } else {
      logInfo('creator.by_uid.avatar_coverage', {
        endpoint: 'GET /creator/by-firebase-uid/:uid',
        firebaseUid: uidRaw,
        creatorId: creator._id.toString(),
        availability,
        hasCallPhoto,
        hasMd,
        hasLegacyPhoto: Boolean(legacyPhoto),
      });
    }

    const creatorOut = {
      id: creator._id.toString(),
      userId: creator.userId ? creator.userId.toString() : null,
      firebaseUid: creator.firebaseUid ? String(creator.firebaseUid) : uidRaw,
      name: creator.name,
      avatar: images.avatar,
      photo: legacyPhoto,
      imageUrl: legacyPhoto,
      price: creator.price,
      age: creator.age,
      location: creator.location,
      categories: creator.categories || [],
      about: '',
      galleryImages: [] as unknown[],
      isFavorite: false,
      availability,
      createdAt: creator.createdAt,
      updatedAt: creator.updatedAt,
    };

    cacheCreatorFeedCardSnapshot({
      id: creatorOut.id,
      userId: creatorOut.userId,
      firebaseUid: creatorOut.firebaseUid,
      name: creatorOut.name,
      avatar: creatorOut.avatar,
      price: creatorOut.price,
      age: creatorOut.age,
      location: creatorOut.location,
      categories: creatorOut.categories,
      availability,
      about: '',
      galleryImages: [],
      isFavorite: false,
    }).catch(() => {});

    logInfo('creator.by_uid.timing', { totalMs: Date.now() - t0 });
    res.json({
      success: true,
      data: {
        creator: creatorOut,
      },
    });
  } catch (error) {
    logError('Get creator by firebase UID error', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// Get single creator by ID (full detail; authenticated; gallery repair optional)
export const getCreatorById = async (req: Request, res: Response): Promise<void> => {
  const t0 = Date.now();
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, error: 'Invalid creator id' });
      return;
    }

    const viewer = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!viewer) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    if (isBdRole(viewer.role)) {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Use agent endpoints for creator data.',
      });
      return;
    }
    if (viewer.role === 'creator') {
      const own = await Creator.findOne({ userId: viewer._id });
      if (!own || own._id.toString() !== id) {
        res.status(403).json({
          success: false,
          error: 'Forbidden: Creators can only fetch their own profile by id.',
        });
        return;
      }
    }

    const detailKey = creatorDetailCacheKey(id);

    if (isRedisConfigured()) {
      const cached = await safeRedisGet<Record<string, unknown>>(detailKey);
      if (cached && typeof cached.id === 'string' && cached.id === id) {
        const firebaseUid = cached.firebaseUid as string | null | undefined;
        const presenceMap =
          firebaseUid && typeof firebaseUid === 'string'
            ? await getBatchCreatorPresence([firebaseUid])
            : {};
        const availability =
          firebaseUid && typeof firebaseUid === 'string'
            ? (presenceMap[firebaseUid]?.state ?? 'offline')
            : 'offline';
        const galleryRaw = cached.galleryImages;
        const galleryImages = Array.isArray(galleryRaw)
          ? serializeCreatorGallery(
              galleryRaw as Parameters<typeof serializeCreatorGallery>[0],
            )
          : [];
        const { v: _v, ...rest } = cached;
        void _v;
        logInfo('creator.detail.timing', { id, cacheHit: true, totalMs: Date.now() - t0 });
        res.json({
          success: true,
          data: {
            creator: {
              ...rest,
              galleryImages,
              availability,
            },
          },
        });
        return;
      }
    }

    const creator = await Creator.findById(id);
    if (!creator) {
      res.status(404).json({ success: false, error: 'Creator not found' });
      return;
    }

    // Cloudflare-Images: URLs are computed from `asset.imageId` at serialize
    // time, so the legacy Firebase token-URL repair / thumb-fill loops are
    // no longer needed. Only normalize the row shape.
    const galleryImages = serializeCreatorGallery(creator.galleryImages);

    let firebaseUid: string | null =
      (creator as unknown as { firebaseUid?: string | null }).firebaseUid ?? null;
    if (!firebaseUid || firebaseUid.trim() === '') {
      const linkedUser = creator.userId
        ? await User.findById(creator.userId).select('firebaseUid').lean()
        : null;
      firebaseUid = linkedUser?.firebaseUid ?? null;
      if (firebaseUid && firebaseUid.trim() !== '') {
        Creator.updateOne({ _id: creator._id }, { $set: { firebaseUid: firebaseUid.trim() } }).catch(
          () => {},
        );
      }
    } else {
      firebaseUid = firebaseUid.trim();
    }

    const presenceMap =
      firebaseUid && typeof firebaseUid === 'string'
        ? await getBatchCreatorPresence([firebaseUid])
        : {};
    const availability =
      firebaseUid && typeof firebaseUid === 'string'
        ? (presenceMap[firebaseUid]?.state ?? 'offline')
        : 'offline';

    const images = serializeCreatorImages(creator);
    const responseCreator = {
      id: creator._id.toString(),
      userId: creator.userId ? creator.userId.toString() : null,
      firebaseUid,
      name: creator.name,
      about: creator.about,
      // Cloudflare-Images
      avatar: images.avatar,
      gallery: images.galleryImages,
      galleryImages,
      categories: creator.categories,
      price: creator.price,
      age: creator.age,
      location: creator.location,
      isOnline: creator.isOnline,
      availability,
      createdAt: creator.createdAt,
      updatedAt: creator.updatedAt,
    };

    if (isRedisConfigured()) {
      const cacheDoc = {
        v: 1,
        id: responseCreator.id,
        userId: responseCreator.userId,
        firebaseUid: responseCreator.firebaseUid,
        name: responseCreator.name,
        about: responseCreator.about,
        avatar: responseCreator.avatar,
        gallery: responseCreator.gallery,
        galleryImages: responseCreator.galleryImages,
        categories: responseCreator.categories,
        price: responseCreator.price,
        age: responseCreator.age,
        location: responseCreator.location,
        isOnline: responseCreator.isOnline,
        createdAt: responseCreator.createdAt,
        updatedAt: responseCreator.updatedAt,
      };
      await safeRedisSet(detailKey, JSON.stringify(cacheDoc) as unknown as string, {
        ex: CREATOR_DETAIL_TTL,
      });
      await registerCreatorDetailCacheKey(detailKey);
    }

    logInfo('creator.detail.timing', { id, cacheHit: false, totalMs: Date.now() - t0 });
    res.json({
      success: true,
      data: { creator: responseCreator },
    });
  } catch (error) {
    logError('Get creator by ID error', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// Create new creator (Admin only) - Requires userId (user must exist first)
export const createCreator = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('➕ [CREATOR] Create creator request');
    
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }
    
    // Check if user is admin
    const adminUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!adminUser || !isSuperAdminRole(adminUser.role)) {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Admin access required',
      });
      return;
    }
    
    const { name, about, userId, categories, price, age, location } = req.body;
    
    // Validation (avatar via Cloudflare commit after create — see adminCreatorAvatarCommit)
    if (!name || !about || !userId || price === undefined) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: name, about, userId, price',
      });
      return;
    }
    
    if (categories !== undefined && (!Array.isArray(categories) || categories.some((c) => typeof c !== 'string'))) {
      res.status(400).json({
        success: false,
        error: 'Categories must be an array of strings',
      });
      return;
    }
    
    const priceCheck = validateCreatorPriceForApi(price);
    if (!priceCheck.ok) {
      res.status(400).json({ success: false, error: priceCheck.error });
      return;
    }
    const validatedPrice = priceCheck.price;
    
    if (age !== undefined && (typeof age !== 'number' || age < 18 || age > 100)) {
      res.status(400).json({
        success: false,
        error: 'Age must be a number between 18 and 100',
      });
      return;
    }

    const locCreate = parseCreatorLocationForCreate(location);
    if (!locCreate.ok) {
      res.status(400).json({ success: false, error: locCreate.error });
      return;
    }
    
    // Verify user exists
    const targetUser = await User.findById(userId);
    if (!targetUser) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }
    
    // Check if user is already a creator
    if (targetUser.role === 'creator') {
      const existingCreator = await Creator.findOne({ userId: targetUser._id });
      if (existingCreator) {
        res.status(409).json({
          success: false,
          error: 'User is already a creator',
        });
        return;
      }
    }
    
    // Check if creator with this userId already exists
    const existingCreator = await Creator.findOne({ userId: targetUser._id });
    if (existingCreator) {
      res.status(409).json({
        success: false,
        error: 'Creator profile already exists for this user',
      });
      return;
    }
    
    const session = await mongoose.startSession();
    let creator;
    try {
      session.startTransaction();

      targetUser.coins = 0;
      if (targetUser.role !== 'creator' && !isSuperAdminRole(targetUser.role)) {
        targetUser.role = 'creator';
      }
      await targetUser.save({ session });
      await ensureCreatorPromotionWalletClearedEntry(targetUser, session);

      const created = await Creator.create(
        [{
          name,
          about,
          galleryImages: [],
          userId: targetUser._id,
          ...(targetUser.firebaseUid ? { firebaseUid: targetUser.firebaseUid.trim() } : {}),
          categories: Array.isArray(categories) ? categories : [],
          price: validatedPrice,
          age: age !== undefined ? age : undefined,
          ...(locCreate.value !== undefined ? { location: locCreate.value } : {}),
        }],
        { session }
      );
      creator = created[0];

      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      await session.endSession();
    }
    
    console.log(`✅ [CREATOR] Creator created: ${creator._id} for user: ${targetUser._id}`);

    invalidateCreatorCatalogCaches().catch(() => {});
    invalidateCreatorDetailCache(creator._id.toString()).catch(() => {});
    const createdUid =
      (creator.firebaseUid && String(creator.firebaseUid).trim()) ||
      (targetUser.firebaseUid && String(targetUser.firebaseUid).trim()) ||
      '';
    if (createdUid) addCreatorFirebaseUidToCache(createdUid).catch(() => {});
    
    res.status(201).json({
      success: true,
      data: {
        creator: {
          id: creator._id.toString(),
          userId: creator.userId.toString(),
          name: creator.name,
          about: creator.about,
          galleryImages: serializeCreatorGallery(creator.galleryImages),
          categories: creator.categories,
          price: creator.price,
          age: creator.age,
          location: creator.location,
          createdAt: creator.createdAt,
          updatedAt: creator.updatedAt,
        },
      },
    });
  } catch (error) {
    console.error('❌ [CREATOR] Create creator error:', error);
    if (error instanceof Error && error.name === 'ValidationError') {
      res.status(400).json({
        success: false,
        error: error.message,
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

/** Stream + socket + admin cache after creator-linked profile data changed (DB already saved). */
export async function notifyCreatorProfileChannels(
  userMongoId: mongoose.Types.ObjectId | string,
  firebaseUid: string,
  options?: { invalidateCatalog?: boolean },
): Promise<void> {
  const uid = typeof userMongoId === 'string' ? userMongoId : userMongoId.toString();
  invalidateCreatorDashboard(uid).catch(() => {});

  try {
    const freshUser = await User.findById(uid);
    if (freshUser) {
      const streamPayload = await getStreamUpsertPayload(freshUser);
      await ensureStreamUser(freshUser.firebaseUid, streamPayload);
      await invalidateOtherMemberCacheForFirebaseUid(freshUser.firebaseUid);
    }
  } catch (syncErr) {
    console.error('⚠️ [CREATOR] Stream/cache sync after profile update failed:', syncErr);
  }

  emitCreatorDataUpdated(firebaseUid, { reason: 'profile_updated' });
  invalidateAdminCaches('overview', 'creators_performance').catch(() => {});

  if (options?.invalidateCatalog) {
    invalidateCreatorCatalogCaches().catch(() => {});
  }
  try {
    const linkedCreator = await Creator.findOne({ userId: uid });
    if (linkedCreator) {
      invalidateCreatorDetailCache(linkedCreator._id.toString()).catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

/**
 * After admin edits creator profile (or linked user / gallery): bump profileRevision,
 * sync Stream, emit creator:data_updated, invalidate caches.
 */
export async function bumpCreatorProfileRevisionForAdmin(
  userMongoId: mongoose.Types.ObjectId | string,
  options?: { invalidateCatalog?: boolean },
): Promise<void> {
  const id = typeof userMongoId === 'string' ? userMongoId : userMongoId.toString();
  const user = await User.findById(id);
  if (!user?.firebaseUid) return;

  user.profileRevision = (user.profileRevision ?? 0) + 1;
  await user.save();

  await notifyCreatorProfileChannels(user._id, user.firebaseUid, {
    invalidateCatalog: options?.invalidateCatalog,
  });
}

// Update creator (Admin only) — updates Creator; mirrors main photo to User.avatar when photo sent; notifies app
export const updateCreator = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    console.log(`✏️ [CREATOR] Update creator: ${id}`);

    if (!(await assertAdminOrOwningAgentForCreator(req, res, id))) return;

    // Legacy `photo` field was removed in Phase E — body intentionally ignored.
    const { name, about, categories, price, age, location } = req.body;

    const creator = await Creator.findById(id);
    if (!creator) {
      res.status(404).json({
        success: false,
        error: 'Creator not found',
      });
      return;
    }

    if (!creator.userId) {
      res.status(400).json({
        success: false,
        error: 'Creator has no linked user',
      });
      return;
    }

    if (price !== undefined) {
      const actor = await User.findOne({ firebaseUid: req.auth?.firebaseUid })
        .select('role staffCapabilities')
        .lean();
      if (!actor) {
        res.status(403).json({
          success: false,
          error: 'Only super admin or BD can change host per-minute price',
        });
        return;
      }
      if (actor.staffCapabilities?.editPricing === false) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permission to edit host pricing',
        });
        return;
      }
      const isAdmin = isSuperAdminRole(actor.role);
      const isBd = isBdRole(actor.role);
      if (!isAdmin && !isBd) {
        res.status(403).json({
          success: false,
          error: 'Only super admin or BD can change host per-minute price',
        });
        return;
      }
      if (isBd) {
        if (!creator.assignedAgencyId) {
          res.status(403).json({
            success: false,
            error: 'Host is not assigned to an agency under your BD account',
          });
          return;
        }
        const agency = await User.findById(creator.assignedAgencyId)
          .select('bdId role')
          .lean();
        if (!agency?.bdId?.equals(actor._id)) {
          res.status(403).json({
            success: false,
            error: 'Forbidden: Host is not under your agencies',
          });
          return;
        }
      }
    }

    let catalogChanged = false;
    
    if (name) {
      const next = typeof name === 'string' ? name.trim() : String(name).trim();
      if (next && creator.name !== next) {
        creator.name = next;
        catalogChanged = true;
      }
    }
    if (about) creator.about = about;
    // Legacy `photo` field was removed in Phase E. Avatars now flow exclusively
    // through the Cloudflare avatar commit endpoint (avatarUploadSessionId).
    
    if (categories !== undefined) {
      if (!Array.isArray(categories) || categories.some((c) => typeof c !== 'string')) {
        res.status(400).json({
          success: false,
          error: 'Categories must be an array of strings',
        });
        return;
      }
      creator.categories = categories;
      catalogChanged = true;
    }
    if (price !== undefined) {
      const priceCheck = validateCreatorPriceForApi(price);
      if (!priceCheck.ok) {
        res.status(400).json({ success: false, error: priceCheck.error });
        return;
      }
      if (creator.price !== priceCheck.price) catalogChanged = true;
      creator.price = priceCheck.price;
    }
    if (age !== undefined) {
      if (typeof age !== 'number' || age < 18 || age > 100) {
        res.status(400).json({
          success: false,
          error: 'Age must be a number between 18 and 100',
        });
        return;
      }
      if (creator.age !== age) catalogChanged = true;
      creator.age = age;
    }

    const locUpdate = parseCreatorLocationForUpdate(location);
    if (locUpdate.kind === 'error') {
      res.status(400).json({ success: false, error: locUpdate.message });
      return;
    }
    if (locUpdate.kind === 'clear') {
      if (creator.location !== undefined) catalogChanged = true;
      creator.set('location', undefined);
    } else if (locUpdate.kind === 'set') {
      if (creator.location !== locUpdate.value) catalogChanged = true;
      creator.location = locUpdate.value;
    }
    
    await creator.save();

    if (price !== undefined) {
      await invalidateCreatorPricingCache(creator._id.toString());
    }
    
    await bumpCreatorProfileRevisionForAdmin(creator.userId, {
      invalidateCatalog: false,
    });

    if (catalogChanged) {
      invalidateCreatorCatalogCaches().catch(() => {});
    }
    invalidateCreatorDetailCache(creator._id.toString()).catch(() => {});
    
    console.log(`✅ [CREATOR] Creator updated: ${creator._id}`);
    
    res.json({
      success: true,
      data: {
        creator: {
          id: creator._id.toString(),
          userId: creator.userId.toString(),
          name: creator.name,
          about: creator.about,
          galleryImages: serializeCreatorGallery(creator.galleryImages),
          categories: creator.categories,
          price: creator.price,
          age: creator.age,
          location: creator.location,
          createdAt: creator.createdAt,
          updatedAt: creator.updatedAt,
        },
      },
    });
  } catch (error) {
    console.error('❌ [CREATOR] Update creator error:', error);
    if (error instanceof Error && error.name === 'ValidationError') {
      res.status(400).json({
        success: false,
        error: error.message,
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// Delete creator — admin may delete any; owning agent may delete assigned creators only.
async function deleteCreatorCore(
  id: string,
  userId: mongoose.Types.ObjectId | undefined,
  session?: mongoose.ClientSession
): Promise<void> {
  const deleteOpts = session ? { session } : {};
  const deleted = await Creator.findByIdAndDelete(id, deleteOpts);
  if (!deleted) return;

  if (!userId) return;
  // Use updateOne (not save) so legacy negative creator coin balances do not fail User validation.
  await User.updateOne(
    { _id: userId, role: 'creator' },
    { $set: { role: 'user', hostOnboardingStatus: 'none' } },
    deleteOpts
  );
}

function isMongoTransactionUnsupported(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /replica set|Transaction numbers are only allowed|transactions are not supported|Transaction aborted|IllegalOperation/i.test(
    msg
  );
}

// Business Rule: Deleting a creator profile ALWAYS downgrades the user role back to 'user'
export const deleteCreator = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    console.log(`🗑️ [CREATOR] Delete creator: ${id}`);
    
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }
    
    const staffUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!staffUser) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const creator = await Creator.findById(id);
    if (!creator) {
      res.status(404).json({
        success: false,
        error: 'Creator not found',
      });
      return;
    }

    let allowed = false;
    if (isSuperAdminRole(staffUser.role)) {
      allowed = true;
    } else if (isAgencyRole(staffUser.role) && !staffUser.agencyDisabled && creator.assignedAgencyId?.equals(staffUser._id)) {
      allowed = true;
    }
    if (!allowed) {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Admin access or ownership of this creator is required',
      });
      return;
    }
    
    const userId = creator.userId;
    let deletedFirebaseUid =
      creator.firebaseUid && String(creator.firebaseUid).trim()
        ? String(creator.firebaseUid).trim()
        : '';
    if (!deletedFirebaseUid && userId) {
      const linked = await User.findById(userId).select('firebaseUid').lean();
      if (linked?.firebaseUid?.trim()) deletedFirebaseUid = linked.firebaseUid.trim();
    }

    try {
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        await deleteCreatorCore(id, userId, session);
        await session.commitTransaction();
      } catch (txErr) {
        await session.abortTransaction().catch(() => {});
        if (!isMongoTransactionUnsupported(txErr)) throw txErr;
        console.warn(
          '⚠️ [CREATOR] Mongo transactions unavailable — falling back to non-transactional delete'
        );
        await deleteCreatorCore(id, userId);
      } finally {
        await session.endSession();
      }

      const actorLabel =
        isSuperAdminRole(staffUser.role)
          ? `Admin: ${staffUser._id} (${staffUser.email || staffUser.phone})`
          : `Agent: ${staffUser._id} (${staffUser.email || staffUser.phone})`;
      console.log(`📝 [AUDIT] CREATOR_PROFILE_DELETED`);
      console.log(`   ${actorLabel}`);
      console.log(`   Creator Profile: ${id}`);
      console.log(`   User: ${userId} (downgraded to 'user')`);
      console.log(`   Timestamp: ${new Date().toISOString()}`);

      console.log(`✅ [CREATOR] Creator deleted: ${id}`);
      if (userId) {
        console.log(`   ✅ User ${userId} downgraded to 'user' role`);
      }

      if (deletedFirebaseUid) {
        try {
          const io = getIO();
          await transitionCreatorPresence(io, deletedFirebaseUid, 'FORCE_OFFLINE', 'admin.deleteCreator');
        } catch (presenceErr) {
          console.warn('⚠️ [CREATOR] Presence cleanup after delete (non-critical):', presenceErr);
        }
      }

      invalidateAdminCaches('overview', 'creators_performance', 'users_analytics').catch(() => {});
      invalidateCreatorCatalogCaches().catch(() => {});
      invalidateCreatorDetailCache(id).catch(() => {});
      if (deletedFirebaseUid) {
        removeCreatorFirebaseUidFromCache(deletedFirebaseUid).catch(() => {});
      }
      removeCreatorFromFeedRank(id).catch(() => {});

      res.json({
        success: true,
        message: 'Creator deleted successfully. User role has been downgraded to "user".',
      });
    } catch (error) {
      console.error('❌ [CREATOR] Delete creator transaction error:', error);
      const msg = error instanceof Error ? error.message : 'Internal server error';
      res.status(500).json({
        success: false,
        error: msg.includes('replica') ? 'Database does not support transactions' : 'Internal server error',
      });
    }
  } catch (error) {
    console.error('❌ [CREATOR] Delete creator error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// Set creator availability toggle (Mongo isOnline + Redis/socket broadcast).
// When CREATOR_AVAILABILITY_TOGGLE_ENABLED=true, this is the primary persistence path
// alongside creator:online / creator:offline socket events.
export const setCreatorOnlineStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const { isOnline } = req.body;
    console.log(`🔄 [CREATOR] Set availability toggle: ${isOnline}`);
    
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }
    
    // Get current user
    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }
    
    // Only creators can set their online status
    if (currentUser.role !== 'creator' && !isSuperAdminRole(currentUser.role)) {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Only creators can set online status',
      });
      return;
    }
    
    // Find creator profile
    const creator = await Creator.findOne({ userId: currentUser._id });
    if (!creator) {
      res.status(404).json({
        success: false,
        error: 'Creator profile not found',
      });
      return;
    }
    
    // Validate isOnline parameter
    if (typeof isOnline !== 'boolean') {
      res.status(400).json({
        success: false,
        error: 'isOnline must be a boolean',
      });
      return;
    }
    
    // Mongo = persistent availability intent (account-level).
    creator.isOnline = isOnline;
    await creator.save();
    
    console.log(`✅ [CREATOR] Creator ${creator._id} availability intent set to: ${isOnline}`);
    
    // Redis + creator:status = runtime truth for fans.
    try {
      const io = getIO();
      await applyCreatorAvailabilityIntent(
        io,
        currentUser.firebaseUid,
        isOnline,
        'creator.controller.setCreatorOnlineStatus',
        isOnline ? { clearStuckCall: false } : undefined
      );
      console.log(
        `📡 [REDIS+SOCKET] Creator availability updated: ${currentUser.firebaseUid} -> ${isOnline ? 'online' : 'offline'}`
      );
    } catch (availabilityError) {
      console.error('⚠️  [REDIS+SOCKET] Failed to update availability:', availabilityError);
      res.status(503).json({
        success: false,
        error:
          'Availability runtime update failed; Mongo intent saved. Retry toggle or reconnect the app.',
        data: {
          creator: {
            id: creator._id.toString(),
            userId: creator.userId.toString(),
            name: creator.name,
            isOnline: creator.isOnline,
          },
        },
      });
      return;
    }
    
    res.json({
      success: true,
      data: {
        creator: {
          id: creator._id.toString(),
          userId: creator.userId.toString(),
          name: creator.name,
          isOnline: creator.isOnline,
        },
      },
    });
  } catch (error) {
    console.error('❌ [CREATOR] Set online status error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// Update creator profile (Creator only - can update their own profile)
export const updateMyCreatorProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('✏️ [CREATOR] Update my creator profile request');
    
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }
    
    // Get current user
    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }
    
    // Only creators can update their own profile
    if (currentUser.role !== 'creator' && !isSuperAdminRole(currentUser.role)) {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Only creators can update their profile',
      });
      return;
    }
    
    // Find creator profile
    const creator = await Creator.findOne({ userId: currentUser._id });
    if (!creator) {
      res.status(404).json({
        success: false,
        error: 'Creator profile not found',
      });
      return;
    }
    
    const {
      name,
      about,
      age,
      categories,
      photo,
      location,
      avatarUploadSessionId,
    } = req.body;
    console.log('📝 [CREATOR] Update request body:', JSON.stringify({
      name,
      about,
      age,
      categories,
      location,
      photo: photo ? 'present' : 'missing',
      avatarUploadSessionId: avatarUploadSessionId ? 'present' : 'missing',
    }));
    let updated = false;
    let catalogChanged = false;
    let avatarChanged = false;

    // ── Cloudflare Images: commit a fresh avatar upload ───────────────────
    if (typeof avatarUploadSessionId === 'string' && avatarUploadSessionId.trim().length > 0) {
      if (!isCloudflareImagesEnabled()) {
        res.status(503).json({
          success: false,
          code: 'IMAGES_DISABLED',
          error: 'Cloudflare Images is not enabled on this deployment',
        });
        return;
      }
      try {
        const { asset } = await commitImageAsset({
          sessionId: avatarUploadSessionId.trim(),
          userId: currentUser._id.toString(),
          userObjectId: currentUser._id,
          purpose: 'creator-avatar',
          quotaScope: 'avatar',
          blurhashTarget: {
            kind: 'creator-avatar',
            creatorId: creator._id.toString(),
          },
        });
        // Preserve the prior avatar so a moderation rejection can roll back.
        if (creator.avatar) {
          creator.previousAvatar = creator.avatar;
        }
        creator.avatar = asset;
        updated = true;
        avatarChanged = true;
        catalogChanged = true;
      } catch (commitError) {
        if (commitError instanceof CommitImageAssetError) {
          res.status(commitError.status).json({
            success: false,
            code: commitError.code,
            error: commitError.message,
          });
          return;
        }
        if (commitError instanceof CloudflareImagesCircuitOpenError) {
          setDegradedHeader(res);
          res.status(503).json({
            success: false,
            code: 'CLOUDFLARE_IMAGES_UNAVAILABLE',
            error: 'image service is temporarily unavailable; please retry',
          });
          return;
        }
        if (commitError instanceof CloudflareImagesError) {
          logError('Creator profile: Cloudflare Images error on avatar commit', commitError);
          res.status(commitError.status >= 500 ? 502 : commitError.status).json({
            success: false,
            code: 'CLOUDFLARE_IMAGES_ERROR',
            error: safeCloudflareImagesClientError(commitError.status),
          });
          return;
        }
        throw commitError;
      }
    }
    
    // Update name
    if (name !== undefined && name !== null) {
      if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100) {
        console.log('❌ [CREATOR] Name validation failed:', { type: typeof name, length: typeof name === 'string' ? name.length : 'N/A', value: name });
        res.status(400).json({
          success: false,
          error: 'Name must be between 2 and 100 characters',
        });
        return;
      }
      creator.name = name.trim();
      updated = true;
      catalogChanged = true;
    }
    
    // Update about
    if (about !== undefined && about !== null) {
      if (typeof about !== 'string' || about.trim().length < 10 || about.trim().length > 1000) {
        console.log('❌ [CREATOR] About validation failed:', { type: typeof about, length: typeof about === 'string' ? about.length : 'N/A', value: about });
        res.status(400).json({
          success: false,
          error: 'About must be between 10 and 1000 characters',
        });
        return;
      }
      creator.about = about.trim();
      updated = true;
    }
    
    // Update age
    if (age !== undefined && age !== null) {
      // Handle both number and string age (JSON might send as string)
      const ageNum = typeof age === 'string' ? parseInt(age, 10) : age;
      if (isNaN(ageNum) || ageNum < 18 || ageNum > 100) {
        console.log('❌ [CREATOR] Age validation failed:', { type: typeof age, value: age, parsed: ageNum });
        res.status(400).json({
          success: false,
          error: 'Age must be a number between 18 and 100',
        });
        return;
      }
      creator.age = ageNum;
      updated = true;
      catalogChanged = true;
    }
    
    // Legacy `photo` field was removed in Phase E — avatars now flow
    // exclusively through the Cloudflare avatar commit pipeline.
    if (photo !== undefined && photo !== null) {
      console.log(
        '⚠️  [CREATOR] Ignoring legacy `photo` field in profile update; use avatarUploadSessionId',
      );
    }

    // Update categories
    if (categories !== undefined && categories !== null) {
      if (!Array.isArray(categories)) {
        console.log('❌ [CREATOR] Categories validation failed: not an array', { type: typeof categories, value: categories });
        res.status(400).json({
          success: false,
          error: 'Categories must be an array of strings',
        });
        return;
      }
      if (categories.some((c) => typeof c !== 'string')) {
        console.log('❌ [CREATOR] Categories validation failed: contains non-string values', { categories });
        res.status(400).json({
          success: false,
          error: 'Categories must be an array of strings',
        });
        return;
      }
      creator.categories = categories;
      updated = true;
      catalogChanged = true;
    }

    const locUp = parseCreatorLocationForUpdate(location);
    if (locUp.kind === 'error') {
      res.status(400).json({ success: false, error: locUp.message });
      return;
    }
    if (locUp.kind === 'clear') {
      creator.set('location', undefined);
      updated = true;
      catalogChanged = true;
    } else if (locUp.kind === 'set') {
      creator.location = locUp.value;
      updated = true;
      catalogChanged = true;
    }
    
    if (!updated) {
      res.status(400).json({
        success: false,
        error: 'No fields to update',
      });
      return;
    }
    
    await creator.save();

    // Cloudflare-Images: no legacy URL repair needed.
    const resolvedGallery = serializeCreatorGallery(creator.galleryImages);

    // Keep User.avatar in sync with the creator avatar so chat lists + Stream
    // stay consistent. Cloudflare-Images is now the only path — legacy photo
    // URL fallback was removed in Phase E.
    if (avatarChanged && creator.avatar) {
      currentUser.avatar = creator.avatar;
      await currentUser.save();
    }

    // Invalidate creator dashboard cache
    invalidateCreatorDashboard(currentUser._id.toString()).catch(() => {});

    try {
      const freshUser = await User.findById(currentUser._id);
      if (freshUser) {
        // Stream Chat: avatar may have changed. Force a fresh upsert so any
        // cached avatar URLs in Stream don't go stale (§6.9 explicit Stream sync).
        const streamPayload = await getStreamUpsertPayload(freshUser);
        await ensureStreamUser(freshUser.firebaseUid, streamPayload);
        await invalidateOtherMemberCacheForFirebaseUid(freshUser.firebaseUid);
      }
    } catch (syncErr) {
      console.error('⚠️ [CREATOR] Stream/cache sync after profile update failed:', syncErr);
    }

    try {
      emitCreatorDataUpdated(currentUser.firebaseUid, { reason: 'profile_updated' });
    } catch (emitErr) {
      console.error('⚠️ [CREATOR] Failed to emit profile_updated:', emitErr);
    }

    if (catalogChanged) {
      invalidateCreatorCatalogCaches().catch(() => {});
    }
    invalidateCreatorDetailCache(creator._id.toString()).catch(() => {});

    console.log(`✅ [CREATOR] Creator profile updated: ${creator._id}`);

    const images = serializeCreatorImages(creator);
    res.json({
      success: true,
      data: {
        creator: {
          id: creator._id.toString(),
          userId: creator.userId.toString(),
          name: creator.name,
          about: creator.about,
          // ── Cloudflare-Images shape ───────────────────────────────────
          avatar: images.avatar,
          galleryImages: resolvedGallery,
          gallery: images.galleryImages,
          age: creator.age,
          categories: creator.categories,
          price: creator.price,
          location: creator.location,
          createdAt: creator.createdAt,
          updatedAt: creator.updatedAt,
        },
      },
    });
  } catch (error) {
    console.error('❌ [CREATOR] Update my creator profile error:', error);
    console.error('❌ [CREATOR] Error details:', {
      name: error instanceof Error ? error.name : 'Unknown',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    if (error instanceof Error && error.name === 'ValidationError') {
      res.status(400).json({
        success: false,
        error: error.message,
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

export const getMyCreatorProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    if (currentUser.role !== 'creator' && !isSuperAdminRole(currentUser.role)) {
      res.status(403).json({ success: false, error: 'Forbidden: Only creators can view profile' });
      return;
    }

    const creator = await Creator.findOne({ userId: currentUser._id });
    if (!creator) {
      res.status(404).json({ success: false, error: 'Creator profile not found' });
      return;
    }

    const galleryImages = serializeCreatorGallery(creator.galleryImages, {
      includePending: true,
    });

    const images = serializeCreatorImages(creator);
    res.json({
      success: true,
      data: {
        creator: {
          id: creator._id.toString(),
          userId: creator.userId.toString(),
          name: creator.name,
          about: creator.about,
          // Cloudflare-Images shape
          avatar: images.avatar,
          galleryImages,
          gallery: images.galleryImages,
          age: creator.age,
          categories: creator.categories,
          price: creator.price,
          location: creator.location,
          createdAt: creator.createdAt,
          updatedAt: creator.updatedAt,
        },
      },
    });
  } catch (error) {
    logError('Get my creator profile error', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const commitGalleryImage = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    if (currentUser.role !== 'creator' && !isSuperAdminRole(currentUser.role)) {
      res.status(403).json({ success: false, error: 'Forbidden: Only creators can commit gallery images' });
      return;
    }

    const creator = await Creator.findOne({ userId: currentUser._id });
    if (!creator) {
      res.status(404).json({ success: false, error: 'Creator profile not found' });
      return;
    }

    const { sessionId, galleryItemId } = req.body ?? {};

    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: 'sessionId is required',
      });
      return;
    }

    if (!isCloudflareImagesEnabled()) {
      res.status(503).json({
        success: false,
        code: 'IMAGES_DISABLED',
        error: 'Cloudflare Images is not enabled on this deployment',
      });
      return;
    }
    const newGalleryItemId =
      typeof galleryItemId === 'string' && galleryItemId.trim().length > 0
        ? galleryItemId.trim()
        : new mongoose.Types.ObjectId().toString();

    const isGallerySlotReplace = (creator.galleryImages || []).some(
      (img) => img.id === newGalleryItemId,
    );

    if ((creator.galleryImages?.length ?? 0) >= CREATOR_GALLERY_MAX_IMAGES) {
      // Allow updating an existing slot; reject only when adding net-new images.
      if (!isGallerySlotReplace) {
        res.status(409).json({
          success: false,
          error: `Maximum ${CREATOR_GALLERY_MAX_IMAGES} gallery images allowed`,
        });
        return;
      }
    }

    try {
      const { asset } = await commitImageAsset({
        sessionId: sessionId.trim(),
        userId: currentUser._id.toString(),
        userObjectId: currentUser._id,
        purpose: 'creator-gallery',
        quotaScope: 'gallery',
        skipQuotaRecord: isGallerySlotReplace,
        blurhashTarget: {
          kind: 'creator-gallery',
          creatorId: creator._id.toString(),
          galleryItemId: newGalleryItemId,
        },
      });

      const existing = creator.galleryImages || [];
      const idx = existing.findIndex((img) => img.id === newGalleryItemId);
      if (idx === -1) {
        existing.push({
          id: newGalleryItemId,
          asset,
          position: existing.length,
          createdAt: new Date(),
        });
      } else {
        existing[idx] = {
          ...existing[idx],
          asset,
        };
      }
      // Re-pack positions for stable ordering.
      creator.galleryImages = [...existing]
        .sort((a, b) => a.position - b.position)
        .map((img, i) => ({ ...img, position: i }));
      await creator.save();
      invalidateCreatorDetailCache(creator._id.toString()).catch(() => {});

      res.json({
        success: true,
        data: {
          galleryItemId: newGalleryItemId,
          galleryImages: serializeCreatorGallery(creator.galleryImages || [], {
            includePending: true,
          }),
        },
      });
      return;
    } catch (commitError) {
      if (commitError instanceof CommitImageAssetError) {
        res.status(commitError.status).json({
          success: false,
          code: commitError.code,
          error: commitError.message,
        });
        return;
      }
      if (commitError instanceof CloudflareImagesCircuitOpenError) {
        setDegradedHeader(res);
        res.status(503).json({
          success: false,
          code: 'CLOUDFLARE_IMAGES_UNAVAILABLE',
          error: 'image service is temporarily unavailable; please retry',
        });
        return;
      }
      if (commitError instanceof CloudflareImagesError) {
        logError('Commit gallery image: Cloudflare Images upstream error', commitError);
        res.status(commitError.status >= 500 ? 502 : commitError.status).json({
          success: false,
          code: 'CLOUDFLARE_IMAGES_ERROR',
          error: safeCloudflareImagesClientError(commitError.status),
        });
        return;
      }
      throw commitError;
    }
  } catch (error) {
    logError('Commit gallery image error', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const deleteGalleryImage = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const { imageId } = req.params;
    if (!imageId || imageId.trim() === '') {
      res.status(400).json({ success: false, error: 'imageId is required' });
      return;
    }

    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    if (currentUser.role !== 'creator' && !isSuperAdminRole(currentUser.role)) {
      res.status(403).json({ success: false, error: 'Forbidden: Only creators can delete gallery images' });
      return;
    }

    const creator = await Creator.findOne({ userId: currentUser._id });
    if (!creator) {
      res.status(404).json({ success: false, error: 'Creator profile not found' });
      return;
    }

    const targetItem = (creator.galleryImages || []).find((img) => img.id === imageId.trim());
    if (!targetItem) {
      res.status(404).json({ success: false, error: 'Gallery image not found' });
      return;
    }

    if ((creator.galleryImages?.length ?? 0) <= CREATOR_GALLERY_MIN_IMAGES) {
      res.status(400).json({
        success: false,
        error: `At least ${CREATOR_GALLERY_MIN_IMAGES} gallery image is required`,
      });
      return;
    }

    const remaining = (creator.galleryImages || []).filter((img) => img.id !== imageId.trim());
    creator.galleryImages = remaining
      .sort((a, b) => a.position - b.position)
      .map((img, i) => ({ ...img, position: i }));
    await creator.save();

    invalidateCreatorDetailCache(creator._id.toString()).catch(() => {});

    // Best-effort Cloudflare cleanup; the orphan-cleanup worker is the
    // backstop, so a failure here is not fatal.
    if (targetItem.asset?.imageId) {
      // Lazy-import the Cloudflare delete to avoid a hard dep at module load.
      void import('../images/cloudflare.client').then(async ({ deleteImage }) => {
        try {
          await deleteImage(targetItem.asset!.imageId);
        } catch (err) {
          logError('Failed to delete Cloudflare image on gallery delete', err, {
            creatorId: creator._id.toString(),
            imageId: targetItem.asset!.imageId,
          });
        }
      });
    }

    res.json({
      success: true,
      data: {
        galleryImages: serializeCreatorGallery(creator.galleryImages || []),
      },
    });
  } catch (error) {
    logError('Delete gallery image error', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const reorderGalleryImages = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    if (currentUser.role !== 'creator' && !isSuperAdminRole(currentUser.role)) {
      res.status(403).json({ success: false, error: 'Forbidden: Only creators can reorder gallery images' });
      return;
    }
    const creator = await Creator.findOne({ userId: currentUser._id });
    if (!creator) {
      res.status(404).json({ success: false, error: 'Creator profile not found' });
      return;
    }

    const imageIds = req.body?.imageIds;
    if (!Array.isArray(imageIds) || imageIds.some((id) => typeof id !== 'string' || id.trim() === '')) {
      res.status(400).json({ success: false, error: 'imageIds must be a non-empty array of strings' });
      return;
    }

    const existingImages = serializeCreatorGallery(creator.galleryImages);
    if (imageIds.length !== existingImages.length) {
      res.status(400).json({ success: false, error: 'imageIds length mismatch with existing gallery images' });
      return;
    }

    const existingIdSet = new Set(existingImages.map((img) => img.id));
    for (const id of imageIds) {
      if (!existingIdSet.has(id.trim())) {
        res.status(422).json({ success: false, error: `Unknown imageId in reorder payload: ${id}` });
        return;
      }
    }

    const imageMap = new Map(existingImages.map((img) => [img.id, img]));
    creator.galleryImages = imageIds.map((id: string, index: number) => ({
      ...imageMap.get(id.trim())!,
      position: index,
    }));
    await creator.save();

    invalidateCreatorDetailCache(creator._id.toString()).catch(() => {});

    res.json({
      success: true,
      data: {
        galleryImages: serializeCreatorGallery(creator.galleryImages),
      },
    });
  } catch (error) {
    logError('Reorder gallery images error', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// Get creator earnings from call history
export const getCreatorEarnings = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('💰 [CREATOR] Get earnings request');
    
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    // Get current user
    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    // Verify user is a creator
    if (currentUser.role !== 'creator' && !isSuperAdminRole(currentUser.role)) {
      res.status(403).json({
        success: false,
        error: 'Only creators can view earnings',
      });
      return;
    }

    // Find creator profile to get price
    const creator = await Creator.findOne({ userId: currentUser._id });
    if (!creator) {
      res.status(404).json({
        success: false,
        error: 'Creator profile not found',
      });
      return;
    }

    // Aggregate all-time summary directly in MongoDB to avoid loading full history into memory.
    const summaryAgg = await CallHistory.aggregate([
      {
        $match: {
          ownerUserId: currentUser._id,
          ownerRole: 'creator',
          durationSeconds: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: null,
          totalEarnings: { $sum: '$coinsEarned' },
          totalSeconds: { $sum: '$durationSeconds' },
          totalCalls: { $sum: 1 },
        },
      },
    ]);

    const summary = summaryAgg[0] || { totalEarnings: 0, totalSeconds: 0, totalCalls: 0 };
    const totalEarnings = summary.totalEarnings || 0;
    const totalSeconds = summary.totalSeconds || 0;
    const totalMinutes = totalSeconds / 60;
    const totalCalls = summary.totalCalls || 0;
    const avgEarningsPerMinute = totalMinutes > 0 ? totalEarnings / totalMinutes : 0;
    const earningsPerMinute = creator.price * CREATOR_SHARE_PERCENTAGE;

    const recentCallRecords = await CallHistory.find({
      ownerUserId: currentUser._id,
      ownerRole: 'creator',
      durationSeconds: { $gt: 0 },
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const calls = recentCallRecords.map((call) => {
      const mins = call.durationSeconds / 60;
      const formatted = call.durationSeconds >= 60
        ? `${Math.floor(call.durationSeconds / 60)}m ${call.durationSeconds % 60}s`
        : `${call.durationSeconds}s`;
      return {
        callId: call.callId,
        callerUsername: call.otherName || 'User',
        duration: call.durationSeconds,
        durationFormatted: formatted,
        durationMinutes: Math.round(mins * 100) / 100,
        earnings: call.coinsEarned,
        endedAt: call.createdAt.toISOString(),
      };
    });

    console.log(`✅ [CREATOR] Earnings: ${totalEarnings} coins from ${totalCalls} calls (${totalMinutes.toFixed(1)} mins)`);

    res.json({
      success: true,
      data: {
        totalEarnings,
        totalMinutes: Math.round(totalMinutes * 100) / 100,
        totalCalls,
        avgEarningsPerMinute: Math.round(avgEarningsPerMinute * 100) / 100,
        earningsPerMinute,
        currentPrice: creator.price,
        creatorSharePercentage: CREATOR_SHARE_PERCENTAGE,
        calls,
      },
    });
  } catch (error) {
    console.error('❌ [CREATOR] Get earnings error:', error);
    console.error('   Error details:', error instanceof Error ? error.stack : error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * Get creator transaction history (earnings from calls)
 * 
 * 🚨 NAMING: Creators use "earnings", "earnedAmount", "totalEarned"
 * ❌ NOT "coins", NOT "balance" (those are for users)
 * 
 * ⚠️ IMPORTANT: These are earnings records, NOT withdrawable balance
 * - No payout/withdrawal functionality yet
 * - Earnings are derived from call history
 * - Payout system will be implemented separately
 * 
 * 🔒 IMMUTABILITY: Call records are append-only
 * - Earnings calculated from immutable call snapshots
 * - Historical earnings never change (price snapshots prevent this)
 */
export const getCreatorTransactions = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('📋 [CREATOR] Get transactions request');
    
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    // Get current user
    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    // Verify user is a creator
    if (currentUser.role !== 'creator' && !isSuperAdminRole(currentUser.role)) {
      res.status(403).json({
        success: false,
        error: 'Only creators can view earnings transactions',
      });
      return;
    }

    // Find creator profile
    const creator = await Creator.findOne({ userId: currentUser._id });
    if (!creator) {
      res.status(404).json({
        success: false,
        error: 'Creator profile not found',
      });
      return;
    }

    // Get pagination params
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const skip = (page - 1) * limit;

    // Query actual transactions from CoinTransaction where this creator is the user
    const transactions = await CoinTransaction.find({ userId: currentUser._id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip);

    const total = await CoinTransaction.countDocuments({ userId: currentUser._id });

    // Calculate total earned from credit transactions
    const totalEarnedResult = await CoinTransaction.aggregate([
      { $match: { userId: currentUser._id, type: 'credit', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$coins' } } },
    ]);
    const totalEarned = totalEarnedResult.length > 0 ? totalEarnedResult[0].total : 0;

    res.json({
      success: true,
      data: {
        transactions: transactions.map(tx => ({
          id: tx._id.toString(),
          transactionId: tx.transactionId,
          type: tx.type,
          coins: tx.coins,
          source: tx.source,
          description: tx.description,
          callId: tx.callId,
          status: tx.status,
          createdAt: tx.createdAt.toISOString(),
        })),
        summary: {
          // 🚨 NAMING: totalEarned (NOT balance, NOT coins, NOT withdrawable)
          // This is earnings history, not available for withdrawal
          totalEarned: Math.round(totalEarned * 100) / 100,
          totalCalls: total,
        },
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
        // ⚠️ IMPORTANT: These are earnings records, not withdrawable balance
        // Payout system will be implemented separately
      },
    });
  } catch (error) {
    console.error('❌ [CREATOR] Get transactions error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// Helper function to format call duration

/**
 * Get creator tasks progress
 * 
 * Calculates total minutes from ended calls and returns task progress.
 * Only ended calls with duration > 0 count towards minutes.
 */
export const getCreatorTasks = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('📋 [CREATOR] Get tasks request');
    
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    // Get current user
    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    // Verify user is a creator
    if (currentUser.role !== 'creator' && !isSuperAdminRole(currentUser.role)) {
      res.status(403).json({
        success: false,
        error: 'Only creators can view tasks',
      });
      return;
    }

    // ── Try Redis cache first ────────────────────────────────────────────
    const cacheKey = creatorTasksKey(currentUser._id.toString());
    try {
      const redis = getRedis();
      const cached = await redis.get(cacheKey);
      if (cached) {
        const data = typeof cached === 'string' ? JSON.parse(cached) : cached;
        console.log('⚡ [CREATOR] Tasks served from Redis cache');
        res.json({ success: true, data });
        return;
      }
    } catch (cacheErr) {
      console.error('⚠️ [CREATOR] Redis cache read failed:', cacheErr);
      // Continue to database query on cache failure
    }

    // ── Daily period bounds ─────────────────────────────────────────────
    const { periodStart, periodEnd, resetsAt } = getDailyPeriodBounds();

    // Compute total minutes from call history **within the current daily period**
    const callAgg = await CallHistory.aggregate([
      {
        $match: {
          ownerUserId: currentUser._id,
          ownerRole: 'creator',
          durationSeconds: { $gt: 0 },
          createdAt: { $gte: periodStart, $lt: periodEnd },
        },
      },
      {
        $group: {
          _id: null,
          totalSeconds: { $sum: '$durationSeconds' },
        },
      },
    ]);
    const totalMinutes = callAgg.length > 0 ? callAgg[0].totalSeconds / 60 : 0;

    // Get existing task progress records **for the current period only**
    const taskProgressRecords = await CreatorTaskProgress.find({
      creatorUserId: currentUser._id,
      periodStart,
    });

    // Create a map of taskKey -> progress record
    const progressMap = new Map<string, ICreatorTaskProgress>();
    for (const record of taskProgressRecords) {
      progressMap.set(record.taskKey, record);
    }

    // Build tasks array with progress
    const tasks = CREATOR_TASKS.map((taskDef) => {
      const progress = progressMap.get(taskDef.key);
      const isCompleted = totalMinutes >= taskDef.thresholdMinutes;
      const isClaimed = progress?.claimedAt != null;
      
      // progressMinutes = min(totalMinutes, thresholdMinutes)
      const progressMinutes = Math.min(totalMinutes, taskDef.thresholdMinutes);

      return {
        taskKey: taskDef.key,
        thresholdMinutes: taskDef.thresholdMinutes,
        rewardCoins: taskDef.rewardCoins,
        progressMinutes: Math.round(progressMinutes * 100) / 100, // Round to 2 decimals
        isCompleted,
        isClaimed,
      };
    });

    const responseData = {
      totalMinutes: Math.round(totalMinutes * 100) / 100, // Round to 2 decimals
      tasks,
      resetsAt: resetsAt.toISOString(),
    };

    // ── Cache in Redis ───────────────────────────────────────────────────
    try {
      const redis = getRedis();
      await redis.setex(cacheKey, CREATOR_TASKS_TTL, JSON.stringify(responseData));
      console.log('💾 [CREATOR] Tasks cached in Redis');
    } catch (cacheErr) {
      console.error('⚠️ [CREATOR] Redis cache write failed:', cacheErr);
      // Continue even if cache write fails
    }

    res.json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error('❌ [CREATOR] Get tasks error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

/**
 * Claim task reward
 * 
 * Validates task completion, creates coin transaction, and credits coins.
 * Idempotent - safe to retry.
 */
export const claimTaskReward = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('🎁 [CREATOR] Claim task reward request');
    
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    const { taskKey } = req.params;

    // Validate task key exists
    if (!isValidTaskKey(taskKey)) {
      res.status(400).json({
        success: false,
        error: 'Invalid task key',
      });
      return;
    }

    const taskDef = getTaskByKey(taskKey);
    if (!taskDef) {
      res.status(404).json({
        success: false,
        error: 'Task not found',
      });
      return;
    }

    // Get current user
    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    // Verify user is a creator
    if (currentUser.role !== 'creator' && !isSuperAdminRole(currentUser.role)) {
      res.status(403).json({
        success: false,
        error: 'Only creators can claim task rewards',
      });
      return;
    }

    // ── Daily period bounds ─────────────────────────────────────────────
    const { periodStart, periodEnd } = getDailyPeriodBounds();

    // Compute total minutes from call history **within the current daily period**
    const claimCallAgg = await CallHistory.aggregate([
      {
        $match: {
          ownerUserId: currentUser._id,
          ownerRole: 'creator',
          durationSeconds: { $gt: 0 },
          createdAt: { $gte: periodStart, $lt: periodEnd },
        },
      },
      {
        $group: {
          _id: null,
          totalSeconds: { $sum: '$durationSeconds' },
        },
      },
    ]);
    const totalMinutes = claimCallAgg.length > 0 ? claimCallAgg[0].totalSeconds / 60 : 0;

    // Check if task is completed (within today's period)
    if (totalMinutes < taskDef.thresholdMinutes) {
      res.status(400).json({
        success: false,
        error: `Task not completed. Current: ${Math.round(totalMinutes)} minutes, Required: ${taskDef.thresholdMinutes} minutes`,
      });
      return;
    }

    // 🔒 PHASE T1: Atomic claim with race safety
    // Use findOneAndUpdate with condition to prevent double claims
    // This prevents: double taps, retry storms, two devices claiming simultaneously
    // **periodStart** is included to scope claims to the current daily period.
    const now = new Date();
    const taskProgress = await CreatorTaskProgress.findOneAndUpdate(
      {
        creatorUserId: currentUser._id,
        taskKey,
        periodStart,
        claimedAt: { $exists: false }, // Only update if not already claimed
      },
      {
        $set: {
          completedAt: now,
          claimedAt: now,
        },
        $setOnInsert: {
          // Only set these on insert (when creating new record)
          creatorUserId: currentUser._id,
          taskKey,
          periodStart,
          thresholdMinutes: taskDef.thresholdMinutes,
          rewardCoins: taskDef.rewardCoins,
        },
      },
      {
        upsert: true, // Create if doesn't exist
        new: true, // Return updated document
      }
    );

    // If taskProgress is null, it means the condition didn't match (already claimed)
    // Check if it was already claimed by querying the existing record
    if (!taskProgress) {
      const existingProgress = await CreatorTaskProgress.findOne({
        creatorUserId: currentUser._id,
        taskKey,
        periodStart,
      });
      
      if (existingProgress?.claimedAt) {
        console.log(`⚠️  [CREATOR] Task ${taskKey} already claimed (race condition prevented)`);
        res.status(409).json({
          success: false,
          error: 'Task reward already claimed',
          data: {
            taskKey,
            rewardCoins: taskDef.rewardCoins,
            coinsAdded: 0,
            newCoinsBalance: currentUser.coins,
            message: 'Task reward already claimed (idempotent)',
          },
        });
        return;
      }
      // If no existing progress found, something went wrong - continue anyway
      console.log(`⚠️  [CREATOR] Task progress not found after update attempt`);
    }

    // Generate transaction ID for idempotency (include timestamp for uniqueness)
    const transactionId = `creator_task_${taskKey}_${currentUser._id}_${Date.now()}`;

    // Check if transaction already exists (idempotency)
    const existingTransaction = await CoinTransaction.findOne({ transactionId });
    if (existingTransaction) {
      console.log(`⚠️  [CREATOR] Duplicate transaction detected: ${transactionId}`);
      res.json({
        success: true,
        data: {
          taskKey,
          rewardCoins: taskDef.rewardCoins,
          coinsAdded: existingTransaction.coins,
          newCoinsBalance: currentUser.coins,
          message: 'Transaction already processed (idempotent)',
        },
      });
      return;
    }

    // Create transaction record (before updating balance)
    const transaction = new CoinTransaction({
      transactionId,
      userId: currentUser._id,
      type: 'credit',
      coins: taskDef.rewardCoins,
      source: 'creator_task',
      description: `Bonus for completing ${taskDef.thresholdMinutes} mins`,
      status: 'completed',
    });

    // Add coins to user account
    const oldCoins = currentUser.coins || 0;
    currentUser.coins = oldCoins + taskDef.rewardCoins;

    // Save transaction and user (task progress already saved by findOneAndUpdate)
    await transaction.save();
    await currentUser.save();

    // 🔥 SCALABILITY FIX: Invalidate tasks and dashboard cache after claim
    try {
      await invalidateCreatorTasks(currentUser._id.toString());
      await invalidateCreatorDashboard(currentUser._id.toString());
    } catch (cacheErr) {
      console.error('⚠️ [CREATOR] Failed to invalidate caches after task claim:', cacheErr);
      // Continue even if cache invalidation fails
    }

    console.log(`✅ [CREATOR] Task reward claimed: ${taskKey}`);
    console.log(`   Coins: ${oldCoins} → ${currentUser.coins} (+${taskDef.rewardCoins})`);

    // 📊 A) Server-side logging for claims (audit trail for disputes)
    console.log(JSON.stringify({
      event: 'creator_task_claimed',
      timestamp: new Date().toISOString(),
      creatorUserId: currentUser._id.toString(),
      taskKey,
      rewardCoins: taskDef.rewardCoins,
      thresholdMinutes: taskDef.thresholdMinutes,
      totalMinutes: Math.round(totalMinutes * 100) / 100,
      transactionId,
      coinsBefore: oldCoins,
      coinsAfter: currentUser.coins,
    }));


    // Balance integrity check (fire-and-forget)
    verifyUserBalance(currentUser._id).catch(() => {});

    // Invalidate dashboard cache so next fetch gets fresh data
    await invalidateCreatorDashboard(currentUser._id.toString());

    // Emit real-time update to the creator via Socket.IO
    try {
      emitCreatorDataUpdated(currentUser.firebaseUid, {
        reason: 'task_claimed',
        taskKey,
        newCoinsBalance: currentUser.coins,
      });
    } catch (emitErr) {
      console.error('⚠️ [CREATOR] Failed to emit data_updated:', emitErr);
    }

    res.json({
      success: true,
      data: {
        taskKey,
        rewardCoins: taskDef.rewardCoins,
        coinsAdded: taskDef.rewardCoins,
        newCoinsBalance: currentUser.coins,
      },
    });
  } catch (error) {
    console.error('❌ [CREATOR] Claim task reward error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// CREATOR DASHBOARD — Single endpoint returning all creator data (cached)
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /creator/dashboard
 *
 * Returns a consolidated view of the creator's data:
 * - Earnings summary (total, per-minute, call count)
 * - Task progress (all tasks with completion/claim status)
 * - Current coins balance
 * - Creator profile info (price, online status)
 *
 * 🔥 CACHED in Redis for 60 seconds. Invalidated after:
 * - Billing settlement (call ends)
 * - Task reward claim
 */
export const getCreatorDashboard = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('📊 [CREATOR] Dashboard request');

    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    if (currentUser.role !== 'creator' && !isSuperAdminRole(currentUser.role)) {
      res.status(403).json({ success: false, error: 'Only creators can access dashboard' });
      return;
    }

    const creator = await Creator.findOne({ userId: currentUser._id });
    if (!creator) {
      res.status(404).json({ success: false, error: 'Creator profile not found' });
      return;
    }

    // Never show a drifted balance in UI; canonicalize coins from ledger on read.
    const canonical = await getCanonicalCoinsAndRepairIfNeeded(
      currentUser._id,
      Number(currentUser.coins) || 0
    );
    const coinsForResponse = canonical.expectedCoins;

    const attachLiveOnline = async (data: Record<string, unknown>): Promise<void> => {
      const live = await getOnlineTodaySecondsLive(currentUser.firebaseUid);
      data.onlineTodaySeconds = live.onlineTodaySeconds;
      data.onlineTodayResetsAt = live.onlineTodayResetsAt;
    };

    // ── Try Redis cache first ────────────────────────────────────────────
    const cacheKey = creatorDashboardKey(currentUser._id.toString());
    try {
      const redis = getRedis();
      const cached = await redis.get(cacheKey);
      if (cached) {
        const data = typeof cached === 'string' ? JSON.parse(cached) : cached;
        // Update coins in cached data (coins can change outside of cache invalidation)
        data.coins = coinsForResponse;
        await attachLiveOnline(data);
        console.log('⚡ [CREATOR] Dashboard served from Redis cache');
        res.json({ success: true, data });
        return;
      }
    } catch (cacheErr) {
      console.error('⚠️ [CREATOR] Redis cache read failed:', cacheErr);
    }

    // ── Build dashboard data from DB ─────────────────────────────────────

    // ── Daily period bounds (for task progress) ───────────────────────
    const { periodStart, periodEnd, resetsAt } = getDailyPeriodBounds();

    // 1. Earnings summary (all-time) from aggregation instead of full-history in-memory reduction.
    const allTimeSummaryAgg = await CallHistory.aggregate([
      {
        $match: {
          ownerUserId: currentUser._id,
          ownerRole: 'creator',
          durationSeconds: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: null,
          totalEarnings: { $sum: '$coinsEarned' },
          totalSeconds: { $sum: '$durationSeconds' },
          totalCalls: { $sum: 1 },
        },
      },
    ]);
    const allTimeSummary = allTimeSummaryAgg[0] || { totalEarnings: 0, totalSeconds: 0, totalCalls: 0 };
    const totalEarnings = allTimeSummary.totalEarnings || 0;
    const totalSeconds = allTimeSummary.totalSeconds || 0;
    const allTimeMinutes = totalSeconds / 60;
    const totalCalls = allTimeSummary.totalCalls || 0;
    const earningsPerMinute = creator.price * CREATOR_SHARE_PERCENTAGE;
    const avgEarningsPerMinute = allTimeMinutes > 0 ? totalEarnings / allTimeMinutes : 0;

    const recentCallRecords = await CallHistory.find({
      ownerUserId: currentUser._id,
      ownerRole: 'creator',
      durationSeconds: { $gt: 0 },
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    const recentCalls = recentCallRecords.map((call) => {
      const formatted = call.durationSeconds >= 60
        ? `${Math.floor(call.durationSeconds / 60)}m ${call.durationSeconds % 60}s`
        : `${call.durationSeconds}s`;
      return {
        callId: call.callId,
        callerUsername: call.otherName || 'User',
        duration: call.durationSeconds,
        durationFormatted: formatted,
        durationMinutes: Math.round((call.durationSeconds / 60) * 100) / 100,
        earnings: call.coinsEarned,
        endedAt: call.createdAt.toISOString(),
      };
    });

    // 2. Today's earnings + task progress — only count calls from the **current daily period**
    const todayCallAgg = await CallHistory.aggregate([
      {
        $match: {
          ownerUserId: currentUser._id,
          ownerRole: 'creator',
          durationSeconds: { $gt: 0 },
          createdAt: { $gte: periodStart, $lt: periodEnd },
        },
      },
      {
        $group: {
          _id: null,
          totalSeconds: { $sum: '$durationSeconds' },
          totalEarned: { $sum: '$coinsEarned' },
          callCount: { $sum: 1 },
        },
      },
    ]);
    const todayMinutes = todayCallAgg.length > 0 ? todayCallAgg[0].totalSeconds / 60 : 0;
    const todayEarnings = todayCallAgg.length > 0 ? todayCallAgg[0].totalEarned : 0;
    const todayCalls = todayCallAgg.length > 0 ? todayCallAgg[0].callCount : 0;

    const taskProgressRecords = await CreatorTaskProgress.find({
      creatorUserId: currentUser._id,
      periodStart,
    });
    const progressMap = new Map<string, ICreatorTaskProgress>();
    for (const record of taskProgressRecords) {
      progressMap.set(record.taskKey, record);
    }

    const tasks = CREATOR_TASKS.map((taskDef) => {
      const progress = progressMap.get(taskDef.key);
      const isCompleted = todayMinutes >= taskDef.thresholdMinutes;
      const isClaimed = progress?.claimedAt != null;
      const progressMinutes = Math.min(todayMinutes, taskDef.thresholdMinutes);
      return {
        taskKey: taskDef.key,
        thresholdMinutes: taskDef.thresholdMinutes,
        rewardCoins: taskDef.rewardCoins,
        progressMinutes: Math.round(progressMinutes * 100) / 100,
        isCompleted,
        isClaimed,
      };
    });

    let momentsAnalytics:
      | {
          momentsEarnings: number;
          purchaseCount: number;
          totalViews: number;
          postCount: number;
        }
      | undefined;

    if (isMomentsEnabled()) {
      const [momentsAgg] = await MomentRevenue.aggregate([
        { $match: { creatorId: creator._id } },
        {
          $group: {
            _id: null,
            totalEarnings: { $sum: '$creatorShareCoins' },
            purchaseCount: { $sum: 1 },
          },
        },
      ]);
      const creatorMoments = await CreatorMoment.find({ creatorId: creator._id });
      const totalViews = creatorMoments.reduce((sum, m) => sum + m.viewsCount, 0);
      momentsAnalytics = {
        momentsEarnings: momentsAgg?.totalEarnings ?? 0,
        purchaseCount: momentsAgg?.purchaseCount ?? 0,
        totalViews,
        postCount: creatorMoments.filter((m) => !m.isDeleted).length,
      };
    }

    // 3. Compose response
    const dashboardData = {
      // Earnings (all-time)
      earnings: {
        totalEarnings,
        totalMinutes: Math.round(allTimeMinutes * 100) / 100,
        totalCalls,
        avgEarningsPerMinute: Math.round(avgEarningsPerMinute * 100) / 100,
        earningsPerMinute,
        currentPrice: creator.price,
        creatorSharePercentage: CREATOR_SHARE_PERCENTAGE,
        calls: recentCalls,
      },
      // Today's earnings (current daily period)
      todayEarnings: {
        totalEarnings: todayEarnings,
        totalMinutes: Math.round(todayMinutes * 100) / 100,
        totalCalls: todayCalls,
      },
      // Tasks (daily period)
      tasks: {
        totalMinutes: Math.round(todayMinutes * 100) / 100,
        items: tasks,
        resetsAt: resetsAt.toISOString(),
      },
      // Account
      coins: coinsForResponse,
      creatorProfile: {
        id: creator._id.toString(),
        name: creator.name,
        price: creator.price,
        location: creator.location,
        isOnline: creator.isOnline,
      },
      ...(momentsAnalytics ? { momentsAnalytics } : {}),
    };

    // ── Cache in Redis ───────────────────────────────────────────────────
    try {
      const redis = getRedis();
      await redis.setex(cacheKey, CREATOR_DASHBOARD_TTL, JSON.stringify(dashboardData));
      console.log('💾 [CREATOR] Dashboard cached in Redis');
    } catch (cacheErr) {
      console.error('⚠️ [CREATOR] Redis cache write failed:', cacheErr);
    }

    console.log(`✅ [CREATOR] Dashboard: ${totalEarnings} earnings, ${totalCalls} calls, ${tasks.length} tasks, ${coinsForResponse} coins`);

    await attachLiveOnline(dashboardData as unknown as Record<string, unknown>);

    res.json({ success: true, data: dashboardData });
  } catch (error) {
    console.error('❌ [CREATOR] Dashboard error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// WITHDRAWAL — Creator requests a withdrawal
// ══════════════════════════════════════════════════════════════════════════

/**
 * POST /creator/withdraw
 *
 * Creator requests to withdraw coins.
 * Rules:
 *   - Must be a creator
 *   - Minimum withdrawal: 1000 coins
 *   - Amount must not exceed current balance
 *   - Coins are NOT deducted at this point (only when payout is marked paid)
 *   - Creates a Withdrawal record with status 'pending'
 */
export const requestWithdrawal = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('💸 [CREATOR] Withdrawal request');

    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    if (currentUser.role !== 'creator' && !isSuperAdminRole(currentUser.role)) {
      res.status(403).json({ success: false, error: 'Only creators can request withdrawals' });
      return;
    }

    const { amount, name, number, upi, accountNumber, ifsc } = req.body;

    if (typeof amount !== 'number' || amount <= 0) {
      res.status(400).json({ success: false, error: 'Amount must be a positive number' });
      return;
    }

    // Validate required withdrawal details
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ success: false, error: 'Name is required' });
      return;
    }

    if (!number || typeof number !== 'string' || number.trim().length === 0) {
      res.status(400).json({ success: false, error: 'Phone number is required' });
      return;
    }

    // At least one payment method must be provided (UPI or Bank Account)
    if ((!upi || upi.trim().length === 0) && 
        ((!accountNumber || accountNumber.trim().length === 0) || 
         (!ifsc || ifsc.trim().length === 0))) {
      res.status(400).json({ 
        success: false, 
        error: 'Either UPI ID or both Account Number and IFSC are required' 
      });
      return;
    }

    // If bank account is provided, both account number and IFSC are required
    if (accountNumber && accountNumber.trim().length > 0) {
      if (!ifsc || ifsc.trim().length === 0) {
        res.status(400).json({ success: false, error: 'IFSC code is required when account number is provided' });
        return;
      }
    }

    if (amount < MIN_CREATOR_WITHDRAWAL_COINS) {
      res.status(400).json({
        success: false,
        error: `Minimum withdrawal amount is ${MIN_CREATOR_WITHDRAWAL_COINS} coins`,
      });
      return;
    }

    if (amount > currentUser.coins) {
      res.status(400).json({
        success: false,
        error: `Insufficient balance. You have ${currentUser.coins} coins but requested ${amount}`,
      });
      return;
    }

    const activeWithdrawal = await Withdrawal.findOne({
      creatorUserId: currentUser._id,
      status: { $in: ACTIVE_WITHDRAWAL_STATUSES },
    })
      .sort({ requestedAt: -1 })
      .limit(1)
      .lean();

    if (activeWithdrawal) {
      const error =
        activeWithdrawal.status === 'pending'
          ? 'You already have a pending withdrawal request. Please wait for it to be processed.'
          : 'You already have an approved withdrawal awaiting payout. Please wait until it is marked paid.';
      res.status(409).json({ success: false, error });
      return;
    }

    const creatorProfile = await Creator.findOne({ userId: currentUser._id })
      .select('_id assignedAgencyId')
      .lean();
    if (!creatorProfile) {
      res.status(404).json({ success: false, error: 'Creator profile not found' });
      return;
    }

    const assignedAgencyId = creatorProfile.assignedAgencyId ?? undefined;
    if (!assignedAgencyId) {
      logInfo('withdrawal_created_without_assignment', {
        creatorUserId: currentUser._id.toString(),
        creatorId: creatorProfile._id.toString(),
      });
    }

    // Create withdrawal record — coins NOT deducted yet
    const withdrawal = await Withdrawal.create({
      creatorUserId: currentUser._id,
      amount,
      status: 'pending',
      requestedAt: new Date(),
      name: name.trim(),
      number: number.trim(),
      upi: upi?.trim() || undefined,
      accountNumber: accountNumber?.trim() || undefined,
      ifsc: ifsc?.trim() || undefined,
      assignedAgencyId,
    });

    console.log(`✅ [CREATOR] Withdrawal requested: ${withdrawal._id} for ${amount} coins by user ${currentUser._id}`);

    // Emit to admin dashboard
    emitToAdmin('withdrawal:requested', {
      withdrawalId: withdrawal._id.toString(),
      creatorUserId: currentUser._id.toString(),
      amount,
    });

    invalidateAdminCaches('overview', 'creators_performance').catch(() => {});

    res.status(201).json({
      success: true,
      data: {
        withdrawalId: withdrawal._id.toString(),
        amount: withdrawal.amount,
        status: withdrawal.status,
        requestedAt: withdrawal.requestedAt.toISOString(),
        name: withdrawal.name ?? null,
        number: withdrawal.number ?? null,
        upi: withdrawal.upi ?? null,
        accountNumber: withdrawal.accountNumber ?? null,
        ifsc: withdrawal.ifsc ?? null,
        assignedAgencyId: withdrawal.assignedAgencyId?.toString() ?? null,
        message: 'Withdrawal request submitted. Coins will be deducted when payout is marked paid.',
      },
    });
  } catch (error) {
    console.error('❌ [CREATOR] Withdrawal request error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/**
 * GET /creator/withdrawals
 *
 * Get the current creator's withdrawal history.
 */
export const getMyWithdrawals = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    if (currentUser.role !== 'creator' && !isSuperAdminRole(currentUser.role)) {
      res.status(403).json({ success: false, error: 'Only creators can view withdrawals' });
      return;
    }

    const withdrawals = await Withdrawal.find({ creatorUserId: currentUser._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    res.json({
      success: true,
      data: {
        withdrawals: withdrawals.map((w) => ({
          id: w._id.toString(),
          amount: w.amount,
          status: w.status,
          requestedAt: w.requestedAt,
          processedAt: w.processedAt || null,
          notes: w.notes || null,
          name: w.name || null,
          number: w.number || null,
          upi: w.upi || null,
          accountNumber: w.accountNumber || null,
          ifsc: w.ifsc || null,
          createdAt: w.createdAt,
        })),
      },
    });
  } catch (error) {
    console.error('❌ [CREATOR] Get withdrawals error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export { emitCreatorDataUpdated } from './creator-notify';
