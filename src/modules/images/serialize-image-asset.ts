/**
 * Serializer for IImageAsset → public API payload.
 *
 * Returns `null` when the asset is missing or moderated out, so controllers
 * can substitute a preset fallback. NEVER expose `imageId` alone to the
 * mobile client — always include the prebuilt variant URLs.
 */

import type { IImageAsset } from './image-asset.schema';
import {
  buildAvatarUrls,
  buildGalleryUrls,
  type AvatarUrls,
  type GalleryUrls,
} from './image-url';

export interface ImageAssetView {
  imageId: string;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  avatarUrls: AvatarUrls;
  galleryUrls: GalleryUrls;
}

export interface SerializeOptions {
  /** When true, also include the pending state (used by admin moderation UI). */
  includePending?: boolean;
}

function isVisible(status: IImageAsset['moderationStatus'], opts: SerializeOptions): boolean {
  if (status === 'rejected') return false;
  if (status === 'pending' && !opts.includePending) return false;
  return true;
}

export function serializeImageAsset(
  asset: IImageAsset | null | undefined,
  options: SerializeOptions = {},
): ImageAssetView | null {
  if (!asset || !asset.imageId) return null;
  if (!isVisible(asset.moderationStatus, options)) return null;

  return {
    imageId: asset.imageId,
    width: asset.width ?? null,
    height: asset.height ?? null,
    blurhash: asset.blurhash ?? null,
    avatarUrls: buildAvatarUrls(asset.imageId),
    galleryUrls: buildGalleryUrls(asset.imageId),
  };
}

/**
 * Convenience: serialize only the avatar slice (avoids generating gallery URLs
 * for paths that never expose them, e.g. small list responses).
 */
export interface AvatarSerialization {
  imageId: string;
  blurhash: string | null;
  width: number | null;
  height: number | null;
  avatarUrls: AvatarUrls;
}

export function serializeAvatar(
  asset: IImageAsset | null | undefined,
  options: SerializeOptions = {},
): AvatarSerialization | null {
  if (!asset || !asset.imageId) return null;
  if (!isVisible(asset.moderationStatus, options)) return null;
  return {
    imageId: asset.imageId,
    blurhash: asset.blurhash ?? null,
    width: asset.width ?? null,
    height: asset.height ?? null,
    avatarUrls: buildAvatarUrls(asset.imageId),
  };
}
