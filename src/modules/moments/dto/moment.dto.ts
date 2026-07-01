import type { ProcessingStatus } from '../../media-shared/types';
import type { MomentAccessReason } from '../services/entitlement.service';

export interface MediaPresentation {
  mediaType: 'image' | 'video';
  thumbnailUrl: string;
  playbackUrl?: string;
  /** Signed HLS token expiry (ms since epoch); used for TTL-aware client refresh. */
  expiresAtMs?: number;
  blurPlaceholder?: string;
  locked: boolean;
  processingStatus: ProcessingStatus;
}

export interface PresentationDTO {
  id: string;
  creatorId: string;
  creatorName: string;
  creatorAvatarUrl?: string;
  media: MediaPresentation;
  caption?: string;
  createdAt: string;
  locked: boolean;
  isPreview: boolean;
  accessReason: MomentAccessReason;
  isFollowing?: boolean;
  likesCount?: number;
  commentsCount?: number;
  isLiked?: boolean;
  processingStatus?: ProcessingStatus;
  moderationStatus?: string;
  moderationReason?: string;
}

export const FEED_DTO_KEYS = [
  'id',
  'creatorId',
  'creatorName',
  'creatorAvatarUrl',
  'media',
  'caption',
  'createdAt',
  'locked',
  'isPreview',
  'accessReason',
  'isFollowing',
  'likesCount',
  'commentsCount',
  'isLiked',
] as const;

export type FeedDTO = Pick<PresentationDTO, (typeof FEED_DTO_KEYS)[number]>;

export type CreatorSelfDTO = PresentationDTO & {
  processingStatus: ProcessingStatus;
  moderationStatus: string;
  moderationReason?: string;
  viewsCount: number;
  purchaseCount: number;
};

export interface MomentCommentDTO {
  id: string;
  authorUserId: string;
  authorName: string;
  authorAvatarUrl?: string;
  isCreator: boolean;
  text: string;
  likesCount: number;
  isLiked: boolean;
  parentCommentId?: string | null;
  replies: MomentCommentDTO[];
  createdAt: string;
}

export interface MomentCommentsPageDTO {
  items: MomentCommentDTO[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface MomentLikeResultDTO {
  likesCount: number;
  isLiked: boolean;
}

export interface MomentShareInfoDTO {
  shareUrl: string;
  deepLink: string;
  playStoreUrl: string;
  title: string;
  thumbnailUrl: string;
}

export interface MomentsFeedSections {
  /**
   * v1: count of items in the admin-curated preview section (indices [0, previewEndIndex)).
   * v2 target: `preview: { start: 0, end: 3 }` plus featured/recommended/ads ranges.
   */
  previewEndIndex: number;
}

export interface MomentsFeedResponse {
  items: FeedDTO[];
  sections: MomentsFeedSections;
  nextCursor?: string;
  hasMore?: boolean;
  nextOffset?: number;
}

export function toFeedDTO(presentation: PresentationDTO): FeedDTO {
  const out: Record<string, unknown> = {};
  for (const key of FEED_DTO_KEYS) {
    out[key] = presentation[key];
  }
  return out as FeedDTO;
}
