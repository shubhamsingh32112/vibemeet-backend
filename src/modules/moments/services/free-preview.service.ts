import type { Types } from 'mongoose';
import mongoose from 'mongoose';
import { getRedis, isRedisConfigured } from '../../../config/redis';
import { getMomentsConfig } from '../../../config/moments';
import { Creator } from '../../creator/creator.model';
import { buildAvatarUrls } from '../../images/image-url';
import type { ICreatorMoment } from '../models/creator-moment.model';
import { CreatorMoment } from '../models/creator-moment.model';
import { FreePreviewMoment, type IFreePreviewMoment } from '../models/free-preview-moment.model';
import {
  FreePreviewListMeta,
  getOrCreateListMeta,
} from '../models/free-preview-list-meta.model';
import {
  bustAllFollowingWarmCaches,
  bustAllPopularFeedCaches,
} from './feed-fanout.service';

const PREVIEW_CACHE_KEY = 'moments:free_preview:active:v2';
const PREVIEW_CACHE_TTL_SEC = 300;

export function calculatePreviewCacheTtlSec(
  rows: Array<Pick<IFreePreviewMoment, 'enabled' | 'startsAt' | 'endsAt'>>,
  now: Date = new Date(),
): number {
  const nowMs = now.getTime();
  const boundaries = rows
    .filter((row) => row.enabled)
    .flatMap((row) => [row.startsAt, row.endsAt])
    .filter((value): value is Date => value instanceof Date && value.getTime() > nowMs)
    .map((value) => Math.max(1, Math.ceil((value.getTime() - nowMs) / 1000)));
  return Math.min(PREVIEW_CACHE_TTL_SEC, ...boundaries);
}

/** Redis stores ids + creator meta only — full moments are reloaded to keep ObjectIds/Dates valid. */
interface PreviewCacheEntry {
  momentId: string;
  creator: PreviewCreatorMeta;
}

export interface PreviewCreatorMeta {
  id: string;
  name: string;
  avatarUrl?: string;
  verified: boolean;
}

export interface PreviewMoment {
  previewRow: IFreePreviewMoment;
  moment: ICreatorMoment;
  creator: PreviewCreatorMeta;
}

export class PreviewListVersionConflictError extends Error {
  readonly code = 'PREVIEW_LIST_VERSION_CONFLICT';
  readonly currentVersion: number;

  constructor(currentVersion: number) {
    super('Preview list was modified by another admin');
    this.name = 'PreviewListVersionConflictError';
    this.currentVersion = currentVersion;
  }
}

/** Visibility precedence for scheduled previews. */
export function isPreviewRowVisible(
  row: Pick<IFreePreviewMoment, 'enabled' | 'startsAt' | 'endsAt'>,
  now: Date = new Date(),
): boolean {
  if (!row.enabled) return false;
  if (row.startsAt && row.startsAt > now) return false;
  if (row.endsAt && row.endsAt < now) return false;
  return true;
}

function publicMomentFilter() {
  return {
    isDeleted: false,
    processingStatus: 'ready' as const,
    moderationStatus: 'approved' as const,
  };
}

async function resolveCreatorMeta(
  creatorId: Types.ObjectId,
): Promise<PreviewCreatorMeta> {
  const creator = await Creator.findById(creatorId).lean();
  if (!creator) {
    return { id: creatorId.toString(), name: 'Creator', verified: false };
  }
  const avatarUrl = creator.avatar?.imageId
    ? buildAvatarUrls(creator.avatar.imageId).sm
    : undefined;
  return {
    id: creator._id.toString(),
    name: creator.name,
    avatarUrl,
    verified: false,
  };
}

async function loadPreviewMomentsFromDb(
  visibleOnly: boolean,
): Promise<PreviewMoment[]> {
  const rows = await FreePreviewMoment.find().sort({ order: 1 }).lean();
  const now = new Date();
  const filtered = visibleOnly
    ? rows.filter((r) => isPreviewRowVisible(r, now))
    : rows;

  const result: PreviewMoment[] = [];
  for (const previewRow of filtered) {
    const moment = await CreatorMoment.findOne({
      _id: previewRow.momentId,
      ...publicMomentFilter(),
    }).lean();
    if (!moment) continue;
    const creator = await resolveCreatorMeta(moment.creatorId);
    result.push({
      previewRow: previewRow as unknown as IFreePreviewMoment,
      moment: moment as unknown as ICreatorMoment,
      creator,
    });
  }
  return result;
}

export async function hydratePreviewMomentsFromCache(
  entries: PreviewCacheEntry[],
): Promise<PreviewMoment[]> {
  if (!entries.length) return [];

  const ids = entries.map((e) => e.momentId);
  const moments = await CreatorMoment.find({
    _id: { $in: ids },
    ...publicMomentFilter(),
  }).lean();
  const byId = new Map(moments.map((m) => [m._id.toString(), m]));

  const result: PreviewMoment[] = [];
  for (const entry of entries) {
    const moment = byId.get(entry.momentId);
    if (!moment) continue;
    result.push({
      previewRow: { momentId: entry.momentId } as unknown as IFreePreviewMoment,
      moment: moment as unknown as ICreatorMoment,
      creator: entry.creator,
    });
  }
  return result;
}

function toPreviewCacheEntries(items: PreviewMoment[]): PreviewCacheEntry[] {
  return items.map((item) => ({
    momentId: item.moment._id.toString(),
    creator: item.creator,
  }));
}

export async function getActivePreviewMoments(): Promise<PreviewMoment[]> {
  if (isRedisConfigured()) {
    const cached = await getRedis().get(PREVIEW_CACHE_KEY);
    if (cached) {
      try {
        const entries = JSON.parse(cached) as PreviewCacheEntry[];
        if (Array.isArray(entries)) {
          return hydratePreviewMomentsFromCache(entries);
        }
      } catch {
        // bust corrupt cache
      }
    }
  }

  const items = await loadPreviewMomentsFromDb(true);

  if (isRedisConfigured()) {
    const scheduleRows = await FreePreviewMoment.find()
      .select('enabled startsAt endsAt')
      .lean();
    await getRedis().setex(
      PREVIEW_CACHE_KEY,
      calculatePreviewCacheTtlSec(scheduleRows),
      JSON.stringify(toPreviewCacheEntries(items)),
    );
  }

  return items;
}

export async function isPreviewMoment(momentId: Types.ObjectId | string): Promise<boolean> {
  const id = typeof momentId === 'string' ? momentId : momentId.toString();
  const active = await getActivePreviewMoments();
  return active.some((p) => p.moment._id.toString() === id);
}

export async function getPreviewMomentIdSet(): Promise<Set<string>> {
  const active = await getActivePreviewMoments();
  return new Set(active.map((p) => p.moment._id.toString()));
}

export async function invalidatePreviewCache(): Promise<void> {
  if (!isRedisConfigured()) return;
  await getRedis().del(PREVIEW_CACHE_KEY);
}

export async function invalidatePreviewAndFeedCaches(): Promise<void> {
  await invalidatePreviewCache();
  await bustAllPopularFeedCaches();
  await bustAllFollowingWarmCaches();
}

export async function getListVersion(): Promise<number> {
  const meta = await getOrCreateListMeta();
  return meta.listVersion;
}

async function incrementListVersion(): Promise<number> {
  const meta = await FreePreviewListMeta.findByIdAndUpdate(
    (await getOrCreateListMeta())._id,
    { $inc: { listVersion: 1 } },
    { new: true, upsert: true },
  );
  return meta?.listVersion ?? 1;
}

export async function listAllPreviewRows(): Promise<{
  items: PreviewMoment[];
  listVersion: number;
}> {
  const items = await loadPreviewMomentsFromDb(false);
  const listVersion = await getListVersion();
  return { items, listVersion };
}

export async function addPreview(
  momentId: string,
  adminUserId: Types.ObjectId,
  opts?: { enabled?: boolean; startsAt?: Date | null; endsAt?: Date | null },
): Promise<{ listVersion: number }> {
  if (!mongoose.Types.ObjectId.isValid(momentId)) {
    throw new Error('Invalid moment id');
  }
  const moment = await CreatorMoment.findOne({
    _id: momentId,
    ...publicMomentFilter(),
  });
  if (!moment) throw new Error('Moment not found or not ready');

  const now = new Date();
  const count = await FreePreviewMoment.countDocuments({
    momentId: { $ne: moment._id },
    enabled: true,
    $or: [{ endsAt: null }, { endsAt: { $gte: now } }],
  });
  const limit = getMomentsConfig().freePreviewLimit;
  if (count >= limit) {
    throw new Error(`Preview limit of ${limit} reached`);
  }

  const maxOrder = await FreePreviewMoment.findOne().sort({ order: -1 }).select('order').lean();
  const order = (maxOrder?.order ?? -1) + 1;

  await FreePreviewMoment.findOneAndUpdate(
    { momentId },
    {
      $set: {
        order,
        enabled: opts?.enabled ?? true,
        startsAt: opts?.startsAt ?? null,
        endsAt: opts?.endsAt ?? null,
        updatedBy: adminUserId,
      },
      $setOnInsert: { createdBy: adminUserId },
    },
    { upsert: true },
  );

  const listVersion = await incrementListVersion();
  await invalidatePreviewAndFeedCaches();
  return { listVersion };
}

export async function removePreview(momentId: string): Promise<{ listVersion: number }> {
  await FreePreviewMoment.deleteOne({ momentId });
  const listVersion = await incrementListVersion();
  await invalidatePreviewAndFeedCaches();
  return { listVersion };
}

export async function updatePreviewSchedule(
  momentId: string,
  adminUserId: Types.ObjectId,
  patch: {
    enabled?: boolean;
    startsAt?: Date | null;
    endsAt?: Date | null;
  },
): Promise<{ listVersion: number }> {
  const updated = await FreePreviewMoment.findOneAndUpdate(
    { momentId },
    {
      $set: {
        ...patch,
        updatedBy: adminUserId,
      },
    },
    { new: true },
  );
  if (!updated) throw new Error('Preview row not found');
  const listVersion = await incrementListVersion();
  await invalidatePreviewAndFeedCaches();
  return { listVersion };
}

export async function reorderPreviews(
  orderedMomentIds: string[],
  expectedVersion: number,
  adminUserId: Types.ObjectId,
): Promise<{ listVersion: number }> {
  const currentVersion = await getListVersion();
  if (currentVersion !== expectedVersion) {
    throw new PreviewListVersionConflictError(currentVersion);
  }

  const limit = getMomentsConfig().freePreviewLimit;
  if (orderedMomentIds.length > limit) {
    throw new Error(`Cannot exceed preview limit of ${limit}`);
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (let i = 0; i < orderedMomentIds.length; i++) {
        await FreePreviewMoment.updateOne(
          { momentId: orderedMomentIds[i] },
          { $set: { order: i, updatedBy: adminUserId } },
          { session },
        );
      }
    });
  } finally {
    await session.endSession();
  }

  const listVersion = await incrementListVersion();
  await invalidatePreviewAndFeedCaches();
  return { listVersion };
}
