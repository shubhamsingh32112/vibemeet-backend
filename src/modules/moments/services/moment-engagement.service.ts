import type { Types } from 'mongoose';
import { Creator } from '../../creator/creator.model';
import { User } from '../../user/user.model';
import { CreatorMoment, type ICreatorMoment } from '../models/creator-moment.model';
import { MomentLike } from '../models/moment-like.model';
import { MomentComment } from '../models/moment-comment.model';
import { MomentCommentLike } from '../models/moment-comment-like.model';
import type {
  MomentCommentDTO,
  MomentCommentsPageDTO,
  MomentLikeResultDTO,
  MomentShareInfoDTO,
} from '../dto/moment.dto';
import { isMomentsFreeAccessMode } from '../../../config/moments';
import { resolveMomentAccess, isCreatorOrAdminRole } from './entitlement.service';
import { isPreviewMoment } from './free-preview.service';
import { buildAvatarUrls } from '../../images/image-url';
import { isVipActive } from '../../vip/vip-entitlement.service';

const ENGAGEMENT_LIKE_WEIGHT = 1;
const ENGAGEMENT_COMMENT_WEIGHT = 2;
const MAX_REPLIES_PREVIEW = 3;

function getMomentShareBaseUrl(): string {
  const base =
    process.env.MOMENT_SHARE_BASE_URL ||
    (process.env.WEB_CHECKOUT_BASE_URL
      ? `${process.env.WEB_CHECKOUT_BASE_URL.replace(/\/$/, '')}/moment`
      : 'http://localhost:8080/moment');
  return base.replace(/\/$/, '');
}

function getPlayStoreUrl(): string {
  return (
    process.env.PLAY_STORE_URL ||
    'https://play.google.com/store/apps/details?id=com.matchvibe.app'
  );
}

function getMomentDeepLinkScheme(): string {
  return process.env.MOMENT_APP_DEEP_LINK_SCHEME || 'zztherapy';
}

export async function loadLikedMomentIds(
  userId: Types.ObjectId | null | undefined,
  momentIds: Types.ObjectId[],
): Promise<Set<string>> {
  if (!userId || momentIds.length === 0) return new Set();
  const likes = await MomentLike.find({
    userId,
    momentId: { $in: momentIds },
  }).select('momentId');
  return new Set(likes.map((l) => l.momentId.toString()));
}

export async function assertMomentEngagementAccess(
  userId: Types.ObjectId,
  moment: ICreatorMoment,
): Promise<{ allowed: boolean; isCreatorOwner: boolean }> {
  const isCreatorOwner = await Creator.findOne({ userId, _id: moment.creatorId }).then(
    (c) => c != null,
  );
  // Match feed presentation: in free access mode any signed-in viewer can engage.
  if (isMomentsFreeAccessMode()) {
    return { allowed: true, isCreatorOwner };
  }
  const preview = !isCreatorOwner ? await isPreviewMoment(moment._id) : false;
  const user = await User.findById(userId);
  const access = await resolveMomentAccess(userId, moment._id, {
    isPreviewMoment: preview,
    isCreatorOwner,
    isCreatorRole: user ? isCreatorOrAdminRole(user.role) : false,
    visibilityTier: moment.visibilityTier ?? 'PUBLIC',
  });
  return { allowed: access.allowed, isCreatorOwner };
}

export async function likeMoment(
  userId: Types.ObjectId,
  momentId: Types.ObjectId,
): Promise<MomentLikeResultDTO> {
  const moment = await CreatorMoment.findById(momentId);
  if (!moment || moment.isDeleted) {
    throw new Error('NOT_FOUND');
  }
  const access = await assertMomentEngagementAccess(userId, moment);
  if (!access.allowed) {
    throw new Error('FORBIDDEN');
  }

  const existing = await MomentLike.findOne({ momentId, userId });
  if (existing) {
    return {
      likesCount: moment.likesCount ?? 0,
      isLiked: true,
    };
  }

  await MomentLike.create({ momentId, userId });
  const updated = await CreatorMoment.findByIdAndUpdate(
    momentId,
    {
      $inc: { likesCount: 1, engagementScore: ENGAGEMENT_LIKE_WEIGHT },
    },
    { new: true },
  );
  return {
    likesCount: updated?.likesCount ?? (moment.likesCount ?? 0) + 1,
    isLiked: true,
  };
}

export async function unlikeMoment(
  userId: Types.ObjectId,
  momentId: Types.ObjectId,
): Promise<MomentLikeResultDTO> {
  const moment = await CreatorMoment.findById(momentId);
  if (!moment || moment.isDeleted) {
    throw new Error('NOT_FOUND');
  }

  const deleted = await MomentLike.findOneAndDelete({ momentId, userId });
  if (!deleted) {
    return {
      likesCount: moment.likesCount ?? 0,
      isLiked: false,
    };
  }

  const updated = await CreatorMoment.findByIdAndUpdate(
    momentId,
    {
      $inc: { likesCount: -1, engagementScore: -ENGAGEMENT_LIKE_WEIGHT },
    },
    { new: true },
  );
  const likesCount = Math.max(0, updated?.likesCount ?? 0);
  if (updated && updated.likesCount < 0) {
    await CreatorMoment.updateOne({ _id: momentId }, { $set: { likesCount: 0 } });
  }
  return { likesCount, isLiked: false };
}

async function resolveCommentAuthors(
  authorIds: Types.ObjectId[],
  momentCreatorId: Types.ObjectId,
): Promise<
  Map<string, { name: string; avatarUrl?: string; isCreator: boolean }>
> {
  const creator = await Creator.findById(momentCreatorId).select('userId name gallery');
  const creatorUserId = creator?.userId?.toString();
  const users = await User.find({ _id: { $in: authorIds } }).select(
    'displayName avatar',
  );
  const map = new Map<string, { name: string; avatarUrl?: string; isCreator: boolean }>();
  for (const user of users) {
    const isCreator = creatorUserId != null && user._id.toString() === creatorUserId;
    const avatarUrl = user.avatar?.imageId
      ? buildAvatarUrls(user.avatar.imageId).sm
      : undefined;
    map.set(user._id.toString(), {
      name: user.displayName || creator?.name || 'User',
      avatarUrl,
      isCreator,
    });
  }
  return map;
}

async function loadLikedCommentIds(
  userId: Types.ObjectId,
  commentIds: Types.ObjectId[],
): Promise<Set<string>> {
  if (commentIds.length === 0) return new Set();
  const likes = await MomentCommentLike.find({
    userId,
    commentId: { $in: commentIds },
  }).select('commentId');
  return new Set(likes.map((l) => l.commentId.toString()));
}

function toCommentDTO(
  comment: InstanceType<typeof MomentComment>,
  authorMeta: { name: string; avatarUrl?: string; isCreator: boolean },
  likedIds: Set<string>,
  replies: MomentCommentDTO[] = [],
): MomentCommentDTO {
  return {
    id: comment._id.toString(),
    authorUserId: comment.authorUserId.toString(),
    authorName: authorMeta.name,
    authorAvatarUrl: authorMeta.avatarUrl,
    isCreator: authorMeta.isCreator,
    isVipHighlighted: comment.isVipHighlighted ?? false,
    text: comment.text,
    likesCount: comment.likesCount ?? 0,
    isLiked: likedIds.has(comment._id.toString()),
    parentCommentId: comment.parentCommentId?.toString() ?? null,
    replies,
    createdAt: comment.createdAt.toISOString(),
  };
}

export async function listMomentComments(
  userId: Types.ObjectId,
  momentId: Types.ObjectId,
  options?: { cursor?: string; limit?: number },
): Promise<MomentCommentsPageDTO> {
  const moment = await CreatorMoment.findById(momentId);
  if (!moment || moment.isDeleted) {
    throw new Error('NOT_FOUND');
  }
  const access = await assertMomentEngagementAccess(userId, moment);
  if (!access.allowed) {
    throw new Error('FORBIDDEN');
  }

  const limit = Math.min(Math.max(options?.limit ?? 20, 1), 50);
  const isFirstPage = !options?.cursor;

  let pinnedHighlightedComments: MomentCommentDTO[] | undefined;
  if (isFirstPage) {
    const highlighted = await MomentComment.find({
      momentId,
      parentCommentId: null,
      isVipHighlighted: true,
      isDeleted: false,
    }).sort({ createdAt: -1 });
    if (highlighted.length > 0) {
      pinnedHighlightedComments = await buildTopLevelCommentDTOs(
        highlighted,
        moment,
        userId,
      );
    }
  }

  const query: Record<string, unknown> = {
    momentId,
    parentCommentId: null,
    // $ne: true includes legacy docs where isVipHighlighted is absent.
    isVipHighlighted: { $ne: true },
    isDeleted: false,
  };
  if (options?.cursor) {
    query.createdAt = { $lt: new Date(options.cursor) };
  }

  const topLevel = await MomentComment.find(query)
    .sort({ createdAt: -1 })
    .limit(limit + 1);

  const hasMore = topLevel.length > limit;
  const page = hasMore ? topLevel.slice(0, limit) : topLevel;
  const items = await buildTopLevelCommentDTOs(page, moment, userId);

  const nextCursor =
    hasMore && page.length > 0 ? page[page.length - 1]!.createdAt.toISOString() : undefined;

  return {
    pinnedHighlightedComments,
    items,
    nextCursor,
    hasMore,
  };
}

async function buildTopLevelCommentDTOs(
  page: InstanceType<typeof MomentComment>[],
  moment: ICreatorMoment,
  userId: Types.ObjectId,
): Promise<MomentCommentDTO[]> {
  if (page.length === 0) return [];

  const topIds = page.map((c) => c._id);
  const replies = await MomentComment.find({
    momentId: moment._id,
    parentCommentId: { $in: topIds },
    isDeleted: false,
  })
    .sort({ createdAt: 1 })
    .limit(topIds.length * MAX_REPLIES_PREVIEW);

  const allCommentIds = [...topIds, ...replies.map((r) => r._id)];
  const authorIds = [
    ...new Set([
      ...page.map((c) => c.authorUserId),
      ...replies.map((r) => r.authorUserId),
    ]),
  ];
  const authorMap = await resolveCommentAuthors(authorIds, moment.creatorId);
  const likedIds = await loadLikedCommentIds(userId, allCommentIds);

  const repliesByParent = new Map<string, InstanceType<typeof MomentComment>[]>();
  for (const reply of replies) {
    const parentId = reply.parentCommentId!.toString();
    const list = repliesByParent.get(parentId) ?? [];
    if (list.length < MAX_REPLIES_PREVIEW) {
      list.push(reply);
      repliesByParent.set(parentId, list);
    }
  }

  return page.map((comment) => {
    const authorMeta = authorMap.get(comment.authorUserId.toString()) ?? {
      name: 'User',
      isCreator: false,
    };
    const replyDtos = (repliesByParent.get(comment._id.toString()) ?? []).map((r) =>
      toCommentDTO(
        r,
        authorMap.get(r.authorUserId.toString()) ?? { name: 'User', isCreator: false },
        likedIds,
      ),
    );
    return toCommentDTO(comment, authorMeta, likedIds, replyDtos);
  });
}

export async function createMomentComment(
  userId: Types.ObjectId,
  momentId: Types.ObjectId,
  text: string,
  parentCommentId?: string,
  options?: { isVipHighlighted?: boolean },
): Promise<MomentCommentDTO> {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 500) {
    throw new Error('INVALID_TEXT');
  }

  const moment = await CreatorMoment.findById(momentId);
  if (!moment || moment.isDeleted) {
    throw new Error('NOT_FOUND');
  }
  const access = await assertMomentEngagementAccess(userId, moment);
  if (!access.allowed) {
    throw new Error('FORBIDDEN');
  }

  let parentId: Types.ObjectId | null = null;
  if (parentCommentId) {
    const parent = await MomentComment.findOne({
      _id: parentCommentId,
      momentId,
      isDeleted: false,
    });
    if (!parent) {
      throw new Error('PARENT_NOT_FOUND');
    }
    parentId = parent._id;
  }

  let isVipHighlighted = false;
  if (options?.isVipHighlighted && !parentId) {
    const vipActive = await isVipActive(userId);
    if (!vipActive) {
      throw new Error('VIP_REQUIRED');
    }
    isVipHighlighted = true;
  }

  const comment = await MomentComment.create({
    momentId,
    authorUserId: userId,
    text: trimmed,
    parentCommentId: parentId,
    isVipHighlighted,
  });

  if (!parentId) {
    await CreatorMoment.findByIdAndUpdate(momentId, {
      $inc: { commentsCount: 1, engagementScore: ENGAGEMENT_COMMENT_WEIGHT },
    });
  }

  const authorMap = await resolveCommentAuthors([userId], moment.creatorId);
  const authorMeta = authorMap.get(userId.toString()) ?? { name: 'User', isCreator: false };
  return toCommentDTO(comment, authorMeta, new Set());
}

export async function deleteMomentComment(
  userId: Types.ObjectId,
  momentId: Types.ObjectId,
  commentId: Types.ObjectId,
): Promise<void> {
  const moment = await CreatorMoment.findById(momentId);
  if (!moment || moment.isDeleted) {
    throw new Error('NOT_FOUND');
  }

  const comment = await MomentComment.findOne({
    _id: commentId,
    momentId,
    isDeleted: false,
  });
  if (!comment) {
    throw new Error('NOT_FOUND');
  }

  const isAuthor = comment.authorUserId.equals(userId);
  const isOwner = await Creator.findOne({ userId, _id: moment.creatorId }).then((c) => c != null);
  if (!isAuthor && !isOwner) {
    throw new Error('FORBIDDEN');
  }

  await MomentComment.updateOne({ _id: commentId }, { $set: { isDeleted: true } });
  if (!comment.parentCommentId) {
    await CreatorMoment.findByIdAndUpdate(momentId, {
      $inc: { commentsCount: -1, engagementScore: -ENGAGEMENT_COMMENT_WEIGHT },
    });
    const updated = await CreatorMoment.findById(momentId);
    if (updated && (updated.commentsCount ?? 0) < 0) {
      await CreatorMoment.updateOne({ _id: momentId }, { $set: { commentsCount: 0 } });
    }
  }
}

export async function likeMomentComment(
  userId: Types.ObjectId,
  momentId: Types.ObjectId,
  commentId: Types.ObjectId,
): Promise<MomentLikeResultDTO> {
  const moment = await CreatorMoment.findById(momentId);
  if (!moment || moment.isDeleted) {
    throw new Error('NOT_FOUND');
  }
  const access = await assertMomentEngagementAccess(userId, moment);
  if (!access.allowed) {
    throw new Error('FORBIDDEN');
  }

  const comment = await MomentComment.findOne({
    _id: commentId,
    momentId,
    isDeleted: false,
  });
  if (!comment) {
    throw new Error('NOT_FOUND');
  }

  const existing = await MomentCommentLike.findOne({ commentId, userId });
  if (existing) {
    return { likesCount: comment.likesCount ?? 0, isLiked: true };
  }

  await MomentCommentLike.create({ commentId, userId });
  const updated = await MomentComment.findByIdAndUpdate(
    commentId,
    { $inc: { likesCount: 1 } },
    { new: true },
  );
  return {
    likesCount: updated?.likesCount ?? (comment.likesCount ?? 0) + 1,
    isLiked: true,
  };
}

export async function unlikeMomentComment(
  userId: Types.ObjectId,
  momentId: Types.ObjectId,
  commentId: Types.ObjectId,
): Promise<MomentLikeResultDTO> {
  const comment = await MomentComment.findOne({
    _id: commentId,
    momentId,
    isDeleted: false,
  });
  if (!comment) {
    throw new Error('NOT_FOUND');
  }

  const deleted = await MomentCommentLike.findOneAndDelete({ commentId, userId });
  if (!deleted) {
    return { likesCount: comment.likesCount ?? 0, isLiked: false };
  }

  const updated = await MomentComment.findByIdAndUpdate(
    commentId,
    { $inc: { likesCount: -1 } },
    { new: true },
  );
  const likesCount = Math.max(0, updated?.likesCount ?? 0);
  if (updated && updated.likesCount < 0) {
    await MomentComment.updateOne({ _id: commentId }, { $set: { likesCount: 0 } });
  }
  return { likesCount, isLiked: false };
}

export async function buildMomentShareInfo(
  momentId: Types.ObjectId,
): Promise<MomentShareInfoDTO> {
  const moment = await CreatorMoment.findById(momentId);
  if (!moment || moment.isDeleted) {
    throw new Error('NOT_FOUND');
  }

  const creator = await Creator.findById(moment.creatorId).select('name');
  const scheme = getMomentDeepLinkScheme();
  const id = momentId.toString();
  const shareBase = getMomentShareBaseUrl();

  let thumbnailUrl = moment.thumbnailFallbackUrl || '';
  if (!thumbnailUrl && moment.imageAsset?.imageId) {
    thumbnailUrl = `https://imagedelivery.net/static/placeholder/moments/thumb`;
  }

  const creatorName = creator?.name ?? 'Creator';
  const captionSnippet = moment.caption?.slice(0, 80) ?? '';

  return {
    shareUrl: `${shareBase}?id=${encodeURIComponent(id)}`,
    deepLink: `${scheme}://moment?id=${encodeURIComponent(id)}`,
    playStoreUrl: getPlayStoreUrl(),
    title: captionSnippet
      ? `${creatorName}: ${captionSnippet}`
      : `Check out ${creatorName} on MatchVibe`,
    thumbnailUrl,
  };
}
