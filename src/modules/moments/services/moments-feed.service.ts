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

export interface PopularFeedCursor {
  feedScore: number;
  id: string;
}

export function encodePopularFeedCursor(cursor: PopularFeedCursor): string {
  return `${cursor.feedScore}:${cursor.id}`;
}

export function decodePopularFeedCursor(cursor: string): PopularFeedCursor | null {
  const separator = cursor.lastIndexOf(':');
  if (separator < 1) return null;
  const feedScore = Number(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  if (!Number.isFinite(feedScore) || !/^[a-f\d]{24}$/i.test(id)) return null;
  return { feedScore, id };
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
    const decoded = decodePopularFeedCursor(cursor);
    if (decoded) {
      Object.assign(query, {
        $or: [
          { feedScore: { $lt: decoded.feedScore } },
          { feedScore: decoded.feedScore, _id: { $lt: decoded.id } },
        ],
      });
    } else {
      // Accept legacy score-only cursors during rolling deployments.
      const cursorScore = Number(cursor);
      if (Number.isFinite(cursorScore)) {
        Object.assign(query, { feedScore: { $lt: cursorScore } });
      }
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
    hasMore && lastFeed
      ? encodePopularFeedCursor({
          feedScore: lastFeed.feedScore,
          id: lastFeed._id.toString(),
        })
      : undefined;

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
  let hasMore = false;
  if (cachedIds?.length) {
    const found = await CreatorMoment.find({
      _id: { $in: cachedIds },
      ...publicMomentQuery(),
    });
    const ordered = orderMomentsByIds(found, cachedIds).filter(
      (m) => !excludeIds.some((id) => id.toString() === m._id.toString()),
    ) as InstanceType<typeof CreatorMoment>[];
    if (cachedIds.length > limit && ordered.length > limit) {
      hasMore = true;
      feedDocs = ordered.slice(0, limit);
    } else {
      feedDocs = [];
    }
  } else {
    feedDocs = [];
  }

  // A short or stale fanout page is not authoritative; MongoDB is the source of truth.
  if (!feedDocs.length && creatorIds.length) {
    const docs = await CreatorMoment.find(
      publicMomentQuery({
        creatorId: { $in: creatorIds },
        ...(excludeIds.length ? { _id: { $nin: excludeIds } } : {}),
      }),
    )
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit + 1);
    hasMore = docs.length > limit;
    feedDocs = docs.slice(0, limit);
  }

  for (const moment of feedDocs) {
    const creatorMeta = await resolveCreatorMetaForMoment(moment.creatorId);
    moments.push({
      moment: moment as unknown as ICreatorMoment,
      section: 'feed',
      creatorMeta,
    });
  }

  return {
    moments,
    sections: { previewEndIndex },
    hasMore,
    nextOffset: offset + feedDocs.length,
  };
}
