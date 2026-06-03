import type { Types } from 'mongoose';
import { buildMomentImageUrls, buildAvatarUrls } from '../../images/image-url';
import type { IImageAsset } from '../../images/image-asset.schema';
import {
  buildSignedPlaybackUrl,
  buildSignedThumbnailUrl,
  getPlaybackTokenExpiresAtMs,
} from '../../stream/signed-token.service';
import { buildStreamThumbnailUrl } from '../../stream/cloudflare-stream.client';
import type { ICreatorMoment } from '../models/creator-moment.model';
import type { ICreatorStory } from '../../stories/models/creator-story.model';
import { Creator } from '../../creator/creator.model';
import {
  type PresentationDTO,
  type CreatorSelfDTO,
  toFeedDTO,
  type FeedDTO,
} from '../dto/moment.dto';
import { hasMomentAccess, canViewDeletedMoment } from './entitlement.service';
import { getMomentsConfig } from '../../../config/moments';
import { isImageModerationPendingByDefault } from '../../../config/cloudflare';
import type { ProcessingStatus } from '../../media-shared/types';

const PLACEHOLDER_THUMB =
  'https://imagedelivery.net/static/placeholder/moments/thumb';

export interface ViewerContext {
  userId: Types.ObjectId | null;
  isCreatorOwner?: boolean;
  followedCreatorIds?: Set<string>;
}

async function resolveCreatorMeta(creatorId: Types.ObjectId) {
  const creator = await Creator.findById(creatorId).lean();
  if (!creator) {
    return { name: 'Creator', avatarUrl: undefined as string | undefined };
  }
  const avatarUrl = creator.avatar?.imageId
    ? buildAvatarUrls(creator.avatar.imageId).sm
    : undefined;
  return { name: creator.name, avatarUrl };
}

function thumbFromImageAsset(asset: IImageAsset | null | undefined, variant: 'blur' | 'feed' = 'feed'): string {
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
      unlockPriceCoins: locked ? moment.priceCoins : undefined,
      processingStatus,
    };
  }

  const videoId = moment.streamVideoId;
  let thumbnailUrl = moment.thumbnailFallbackUrl || PLACEHOLDER_THUMB;
  if (videoId) {
    thumbnailUrl = locked
      ? await buildSignedThumbnailUrl(videoId, 400)
      : buildStreamThumbnailUrl(videoId, 600);
  }
  if (moment.thumbnailAsset?.imageId) {
    thumbnailUrl = thumbFromImageAsset(moment.thumbnailAsset, 'feed');
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
    blurPlaceholder: moment.thumbnailAsset?.blurhash ?? moment.imageAsset?.blurhash ?? undefined,
    locked,
    unlockPriceCoins: locked ? moment.priceCoins : undefined,
    processingStatus,
  };
}

export async function toMomentPresentationDTO(
  moment: ICreatorMoment,
  viewer: ViewerContext,
): Promise<PresentationDTO | null> {
  if (moment.processingStatus !== 'ready' || moment.moderationStatus !== 'approved') {
    if (!viewer.isCreatorOwner) return null;
  }

  if (moment.isDeleted && !(await canViewDeletedMoment(viewer.userId, moment._id))) {
    return null;
  }

  const entitled =
    moment.accessType === 'free' ||
    (viewer.userId ? await hasMomentAccess(viewer.userId, moment._id) : false) ||
    (moment.isDeleted && viewer.userId
      ? await canViewDeletedMoment(viewer.userId, moment._id)
      : false);

  const locked = moment.accessType === 'paid' && !entitled;
  const meta = await resolveCreatorMeta(moment.creatorId);

  return {
    id: moment._id.toString(),
    creatorId: moment.creatorId.toString(),
    creatorName: meta.name,
    creatorAvatarUrl: meta.avatarUrl,
    media: await buildMomentMedia(moment, locked),
    caption: moment.caption ?? undefined,
    createdAt: moment.createdAt.toISOString(),
    locked,
    unlockPriceCoins: locked ? moment.priceCoins : undefined,
    processingStatus: moment.processingStatus,
    isFollowing: viewer.followedCreatorIds?.has(moment.creatorId.toString()) ?? false,
  };
}

export async function toMomentFeedDTO(
  moment: ICreatorMoment,
  viewer: ViewerContext,
): Promise<FeedDTO | null> {
  const presentation = await toMomentPresentationDTO(moment, viewer);
  if (!presentation) return null;
  return toFeedDTO(presentation);
}

export async function toCreatorSelfMomentDTO(
  moment: ICreatorMoment,
  viewer: ViewerContext,
): Promise<CreatorSelfDTO | null> {
  const base = await toMomentPresentationDTO(moment, { ...viewer, isCreatorOwner: true });
  if (!base) return null;
  return {
    ...base,
    processingStatus: moment.processingStatus,
    moderationStatus: moment.moderationStatus,
    moderationReason: moment.moderationReason ?? undefined,
    viewsCount: moment.viewsCount,
    purchaseCount: moment.purchaseCount,
    accessType: moment.accessType,
  };
}

export function defaultModerationStatus(): 'pending' | 'approved' {
  return isImageModerationPendingByDefault() ? 'pending' : 'approved';
}

export function resolvePriceCoins(type: 'photo' | 'video', accessType: 'free' | 'paid'): number {
  if (accessType === 'free') return 0;
  const cfg = getMomentsConfig();
  return type === 'photo' ? cfg.photoPriceCoins : cfg.videoPriceCoins;
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

// Re-export gallery urls helper used above — buildMomentImageUrls added in image-url.ts
