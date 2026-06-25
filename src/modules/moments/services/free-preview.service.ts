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

const PREVIEW_CACHE_KEY = 'moments:free_preview:active:v1';
const PREVIEW_CACHE_TTL_SEC = 300;

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

export async function getActivePreviewMoments(): Promise<PreviewMoment[]> {
  if (isRedisConfigured()) {
    const cached = await getRedis().get(PREVIEW_CACHE_KEY);
    if (cached) {
      try {
        return JSON.parse(cached) as PreviewMoment[];
      } catch {
        // bust corrupt cache
      }
    }
  }

  const items = await loadPreviewMomentsFromDb(true);

  if (isRedisConfigured()) {
    await getRedis().setex(
      PREVIEW_CACHE_KEY,
      PREVIEW_CACHE_TTL_SEC,
      JSON.stringify(items),
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

  const count = await FreePreviewMoment.countDocuments();
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
