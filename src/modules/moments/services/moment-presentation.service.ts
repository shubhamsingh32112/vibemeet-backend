import type { Types } from 'mongoose';
import { buildMomentImageUrls } from '../../images/image-url';
import type { IImageAsset } from '../../images/image-asset.schema';
import {
  buildSignedPlaybackUrl,
  buildSignedThumbnailUrl,
  getPlaybackTokenExpiresAtMs,
} from '../../stream/signed-token.service';
import type { ICreatorMoment } from '../models/creator-moment.model';
import type { ICreatorStory } from '../../stories/models/creator-story.model';
import {
  type PresentationDTO,
  type CreatorSelfDTO,
  toFeedDTO,
  type FeedDTO,
} from '../dto/moment.dto';
import { isMomentsFreeAccessMode } from '../../../config/moments';
import { UploadRewardStatus } from '../types/upload-reward-status';
import {
  resolveMomentAccess,
  canViewDeletedMoment,
  type MomentAccessReason,
} from './entitlement.service';
import { isImageModerationPendingByDefault } from '../../../config/cloudflare';
import type { ProcessingStatus } from '../../media-shared/types';
import type { PreviewCreatorMeta } from './free-preview.service';
import type { FeedSection } from './moments-feed.service';

const PLACEHOLDER_THUMB =
  'https://imagedelivery.net/static/placeholder/moments/thumb';

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export interface ViewerContext {
  userId: Types.ObjectId | null;
  isCreatorOwner?: boolean;
  followedCreatorIds?: Set<string>;
  likedMomentIds?: Set<string>;
  isStaffAdmin?: boolean;
  isCreatorRole?: boolean;
}

function thumbFromImageAsset(
  asset: IImageAsset | null | undefined,
  variant: 'blur' | 'feed' = 'feed',
): string {
  if (!asset?.imageId) return PLACEHOLDER_THUMB;
  const urls = buildMomentImageUrls(asset.imageId);
  return variant === 'blur' ? urls.blur : urls.feed;
}

async function buildMomentMedia(
  moment: ICreatorMoment,
  locked: boolean,
): Promise<PresentationDTO['media']> {
  const processingStatus = moment.processingStatus;
  if (moment.type === 'photo') {
    const thumbnailUrl = locked
      ? thumbFromImageAsset(moment.imageAsset, 'blur')
      : thumbFromImageAsset(moment.imageAsset, 'feed');
    let playbackUrl: string | undefined;
    if (!locked && moment.imageAsset?.imageId) {
      playbackUrl = buildMomentImageUrls(moment.imageAsset.imageId).fullscreen;
    }
    return {
      mediaType: 'image',
      thumbnailUrl: moment.thumbnailFallbackUrl || thumbnailUrl,
      playbackUrl,
      blurPlaceholder: moment.imageAsset?.blurhash ?? undefined,
      locked,
      processingStatus,
    };
  }

  const videoId = moment.streamVideoId;
  let thumbnailUrl = moment.thumbnailFallbackUrl || PLACEHOLDER_THUMB;
  if (moment.thumbnailAsset?.imageId) {
    thumbnailUrl = thumbFromImageAsset(moment.thumbnailAsset, 'feed');
  } else if (videoId) {
    const signedThumb = await buildSignedThumbnailUrl(videoId, locked ? 400 : 600);
    thumbnailUrl =
      moment.thumbnailValidated === false && moment.thumbnailFallbackUrl
        ? moment.thumbnailFallbackUrl
        : signedThumb;
  }

  let playbackUrl: string | undefined;
  let expiresAtMs: number | undefined;
  if (!locked && videoId) {
    playbackUrl = await buildSignedPlaybackUrl(videoId);
    expiresAtMs = getPlaybackTokenExpiresAtMs();
  }

  return {
    mediaType: 'video',
    thumbnailUrl,
    playbackUrl,
    expiresAtMs,
    blurPlaceholder:
      moment.thumbnailAsset?.blurhash ?? moment.imageAsset?.blurhash ?? undefined,
    locked,
    processingStatus,
  };
}

export async function toMomentPresentationDTO(
  moment: ICreatorMoment,
  viewer: ViewerContext,
  options?: {
    section?: FeedSection;
    creatorMeta?: PreviewCreatorMeta;
    isPreviewMoment?: boolean;
  },
): Promise<PresentationDTO | null> {
  if (moment.processingStatus !== 'ready' || moment.moderationStatus !== 'approved') {
    if (!viewer.isCreatorOwner) return null;
  }

  if (moment.isDeleted && !(await canViewDeletedMoment(viewer.userId, moment._id))) {
    return null;
  }

  const isPreviewMoment =
    options?.isPreviewMoment ?? options?.section === 'preview';

  let locked: boolean;
  let accessReason: MomentAccessReason;

  if (isMomentsFreeAccessMode()) {
    const allowed = viewer.userId != null || viewer.isCreatorOwner === true;
    locked = !allowed;
    accessReason = allowed ? 'PREMIUM' : 'DENIED';
  } else {
    const access = await resolveMomentAccess(viewer.userId, moment._id, {
      isCreatorOwner: viewer.isCreatorOwner,
      isPreviewMoment,
      isStaffAdmin: viewer.isStaffAdmin,
      isCreatorRole: viewer.isCreatorRole,
      visibilityTier: moment.visibilityTier ?? 'PUBLIC',
    });
    locked = !access.allowed;
    accessReason = access.reason;
  }
  const meta = options?.creatorMeta ?? {
    id: moment.creatorId.toString(),
    name: 'Creator',
    verified: false,
  };

  return {
    id: moment._id.toString(),
    creatorId: moment.creatorId.toString(),
    creatorName: meta.name,
    creatorAvatarUrl: meta.avatarUrl,
    media: await buildMomentMedia(moment, locked),
    caption: moment.caption ?? undefined,
    createdAt: toIsoString(moment.createdAt),
    locked,
    isPreview: accessReason === 'PREVIEW',
    accessReason,
    processingStatus: moment.processingStatus,
    isFollowing: viewer.followedCreatorIds?.has(moment.creatorId.toString()) ?? false,
    likesCount: moment.likesCount ?? 0,
    commentsCount: moment.commentsCount ?? 0,
    isLiked: viewer.likedMomentIds?.has(moment._id.toString()) ?? false,
  };
}

export async function toMomentFeedDTO(
  moment: ICreatorMoment,
  viewer: ViewerContext,
  options?: {
    section?: FeedSection;
    creatorMeta?: PreviewCreatorMeta;
    isPreviewMoment?: boolean;
  },
): Promise<FeedDTO | null> {
  const presentation = await toMomentPresentationDTO(moment, viewer, options);
  if (!presentation) return null;
  return toFeedDTO(presentation);
}

export async function presentationFromFeedOrderingItem(
  item: {
    moment: ICreatorMoment;
    section: FeedSection;
    creatorMeta: PreviewCreatorMeta;
  },
  viewer: ViewerContext,
): Promise<FeedDTO | null> {
  return toMomentFeedDTO(item.moment, viewer, {
    section: item.section,
    creatorMeta: item.creatorMeta,
    isPreviewMoment: item.section === 'preview',
  });
}

/** Pre-field moments were credited on upload — treat missing status as approved. */
export function resolveUploadRewardStatusForDto(
  moment: Pick<ICreatorMoment, 'uploadRewardStatus'>,
): UploadRewardStatus {
  const raw = moment.uploadRewardStatus;
  if (
    raw === UploadRewardStatus.Pending ||
    raw === UploadRewardStatus.Approved ||
    raw === UploadRewardStatus.Rejected
  ) {
    return raw;
  }
  return UploadRewardStatus.Approved;
}

export async function toCreatorSelfMomentDTO(
  moment: ICreatorMoment,
  viewer: ViewerContext,
): Promise<CreatorSelfDTO | null> {
  const base = await toMomentPresentationDTO(moment, {
    ...viewer,
    isCreatorOwner: true,
  });
  if (!base) return null;
  return {
    ...base,
    processingStatus: moment.processingStatus,
    moderationStatus: moment.moderationStatus,
    moderationReason: moment.moderationReason ?? undefined,
    uploadRewardStatus: resolveUploadRewardStatusForDto(moment),
    viewsCount: moment.viewsCount,
    purchaseCount: moment.purchaseCount,
  };
}

export function defaultModerationStatus(): 'pending' | 'approved' {
  return isImageModerationPendingByDefault() ? 'pending' : 'approved';
}

export interface StoryPresentationDTO {
  id: string;
  creatorId: string;
  type: 'image' | 'video';
  media: PresentationDTO['media'];
  caption?: string;
  createdAt: string;
  expiresAt: string;
  viewsCount?: number;
  processingStatus?: ProcessingStatus;
  moderationStatus?: string;
  moderationReason?: string;
}

export async function toStoryPresentationDTO(
  story: ICreatorStory,
  viewer: ViewerContext,
): Promise<StoryPresentationDTO | null> {
  if (story.processingStatus !== 'ready' || story.moderationStatus !== 'approved') {
    if (!viewer.isCreatorOwner) return null;
  }
  if (story.isDeleted) return null;

  const locked = false;
  let media: PresentationDTO['media'];
  if (story.type === 'image' && story.imageAsset?.imageId) {
    const urls = buildMomentImageUrls(story.imageAsset.imageId);
    media = {
      mediaType: 'image',
      thumbnailUrl: story.thumbnailFallbackUrl || urls.feed,
      playbackUrl: urls.fullscreen,
      blurPlaceholder: story.imageAsset.blurhash ?? undefined,
      locked,
      processingStatus: story.processingStatus,
    };
  } else if (story.type === 'video' && story.streamVideoId) {
    media = {
      mediaType: 'video',
      thumbnailUrl:
        story.thumbnailFallbackUrl ||
        (await buildSignedThumbnailUrl(story.streamVideoId, 600)),
      playbackUrl: await buildSignedPlaybackUrl(story.streamVideoId),
      expiresAtMs: getPlaybackTokenExpiresAtMs(),
      locked,
      processingStatus: story.processingStatus,
    };
  } else {
    return null;
  }

  return {
    id: story._id.toString(),
    creatorId: story.creatorId.toString(),
    type: story.type,
    media,
    caption: story.caption ?? undefined,
    createdAt: story.createdAt.toISOString(),
    expiresAt: story.expiresAt.toISOString(),
    viewsCount: viewer.isCreatorOwner ? story.viewsCount : undefined,
    ...(viewer.isCreatorOwner
      ? {
          processingStatus: story.processingStatus,
          moderationStatus: story.moderationStatus,
          moderationReason: story.moderationReason ?? undefined,
        }
      : {}),
  };
}

export type { MomentAccessReason };
