import type { Types } from 'mongoose';
import { CreatorMoment, type ICreatorMoment } from '../models/creator-moment.model';
import { CreatorFollow } from '../models/creator-follow.model';
import { getActivePreviewMoments } from './free-preview.service';
import { orderMomentsByIds } from './feed-fanout.service';
import { resolveCreatorMetaForMoment } from './creator-meta.service';
import type { PreviewCreatorMeta } from './free-preview.service';

export type FeedSection = 'preview' | 'feed';

export interface FeedOrderingItem {
  moment: ICreatorMoment;
  section: FeedSection;
  creatorMeta: PreviewCreatorMeta;
}

export interface FeedOrderingResult {
  moments: FeedOrderingItem[];
  sections: {
    previewEndIndex: number;
  };
  nextCursor?: string;
  hasMore?: boolean;
  nextOffset?: number;
}

function publicMomentQuery(extra: Record<string, unknown> = {}) {
  return {
    isDeleted: false,
    processingStatus: 'ready' as const,
    moderationStatus: 'approved' as const,
    ...extra,
  };
}

/**
 * Editorial order: FreePreviewMoment.order (pinned preview section).
 * Chronological order: CreatorMoment.feedScore desc (main feed section).
 * Feed Service does NOT compute locked/unlocked or premium audience — see feed-audience.service.
 */
export async function buildPopularFeedOrdering(input: {
  limit: number;
  cursor?: string;
}): Promise<FeedOrderingResult> {
  const { limit, cursor } = input;
  const moments: FeedOrderingItem[] = [];
  let previewEndIndex = 0;
  const isFirstPage = !cursor;

  if (isFirstPage) {
    const previews = await getActivePreviewMoments();
    for (const p of previews) {
      moments.push({
        moment: p.moment,
        section: 'preview',
        creatorMeta: p.creator,
      });
    }
    previewEndIndex = moments.length;
  }

  const excludeIds = moments.map((m) => m.moment._id);

  const query = publicMomentQuery();
  if (cursor) {
    const cursorScore = Number(cursor);
    if (Number.isFinite(cursorScore)) {
      Object.assign(query, { feedScore: { $lt: cursorScore } });
    }
  }
  if (excludeIds.length) {
    Object.assign(query, { _id: { $nin: excludeIds } });
  }

  const feedDocs = await CreatorMoment.find(query)
    .sort({ feedScore: -1, _id: -1 })
    .limit(limit + 1);

  const feedSlice = feedDocs.slice(0, limit);
  for (const moment of feedSlice) {
    const creatorMeta = await resolveCreatorMetaForMoment(moment.creatorId);
    moments.push({
      moment: moment as unknown as ICreatorMoment,
      section: 'feed',
      creatorMeta,
    });
  }

  const hasMore = feedDocs.length > limit;
  const lastFeed = feedSlice[feedSlice.length - 1];
  const nextCursor =
    hasMore && lastFeed ? String(lastFeed.feedScore) : undefined;

  return {
    moments,
    sections: { previewEndIndex },
    nextCursor,
  };
}

export async function buildFollowingFeedOrdering(input: {
  userId: Types.ObjectId;
  limit: number;
  offset: number;
  cachedIds?: string[] | null;
}): Promise<FeedOrderingResult> {
  const { userId, limit, offset, cachedIds } = input;
  const moments: FeedOrderingItem[] = [];
  let previewEndIndex = 0;
  const isFirstPage = offset === 0;

  const follows = await CreatorFollow.find({ followerUserId: userId }).select('creatorId');
  const followedCreatorIds = new Set(follows.map((f) => f.creatorId.toString()));

  if (isFirstPage) {
    const previews = await getActivePreviewMoments();
    for (const p of previews) {
      if (!followedCreatorIds.has(p.moment.creatorId.toString())) continue;
      moments.push({
        moment: p.moment,
        section: 'preview',
        creatorMeta: p.creator,
      });
    }
    previewEndIndex = moments.length;
  }

  const excludeIds = moments.map((m) => m.moment._id);
  const creatorIds = follows.map((f) => f.creatorId);

  let feedDocs: InstanceType<typeof CreatorMoment>[];
  if (cachedIds?.length) {
    const found = await CreatorMoment.find({
      _id: { $in: cachedIds },
      ...publicMomentQuery(),
    });
    feedDocs = orderMomentsByIds(found, cachedIds).filter(
      (m) => !excludeIds.some((id) => id.equals(m._id)),
    ) as InstanceType<typeof CreatorMoment>[];
  } else if (creatorIds.length) {
    feedDocs = await CreatorMoment.find(
      publicMomentQuery({
        creatorId: { $in: creatorIds },
        ...(excludeIds.length ? { _id: { $nin: excludeIds } } : {}),
      }),
    )
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit);
  } else {
    feedDocs = [];
  }

  for (const moment of feedDocs) {
    const creatorMeta = await resolveCreatorMetaForMoment(moment.creatorId);
    moments.push({
      moment: moment as unknown as ICreatorMoment,
      section: 'feed',
      creatorMeta,
    });
  }

  const hasMore = feedDocs.length >= limit;
  return {
    moments,
    sections: { previewEndIndex },
    hasMore,
    nextOffset: offset + feedDocs.length,
  };
}
