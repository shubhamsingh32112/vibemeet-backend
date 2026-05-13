/**
 * Serialization helpers for creator + user image fields.
 *
 * Builds the canonical API payload shape:
 *   avatar:        AvatarSerialization | null   (Cloudflare)
 *   galleryImages: Array<{ id, position, createdAt, image }>
 *
 * Legacy Firebase fields (`photo`, gallery url/storagePath/thumbnailUrl,
 * stringy user.avatar) were removed in Phase E of the migration.
 *
 * Controllers should call these instead of poking at avatars directly.
 */

import type { ICreator, ICreatorGalleryImage } from '../creator/creator.model';
import type { IUser } from '../user/user.model';
import {
  serializeAvatar,
  serializeImageAsset,
  type AvatarSerialization,
  type ImageAssetView,
  type SerializeOptions,
} from './serialize-image-asset';

export interface SerializedCreatorImages {
  avatar: AvatarSerialization | null;
  galleryImages: SerializedGalleryItem[];
}

export interface SerializedGalleryItem {
  id: string;
  position: number;
  createdAt: Date;
  image: ImageAssetView | null;
}

export function serializeCreatorImages(creator: ICreator): SerializedCreatorImages {
  const avatar = serializeAvatar(creator.avatar ?? null);
  const galleryImages = serializeCreatorGallery(creator.galleryImages || []);
  return {
    avatar,
    galleryImages,
  };
}

export function serializeCreatorGallery(
  items: ICreatorGalleryImage[],
  options: SerializeOptions = {},
): SerializedGalleryItem[] {
  return [...items]
    .sort((a, b) => a.position - b.position || +new Date(a.createdAt) - +new Date(b.createdAt))
    .map((item, idx): SerializedGalleryItem => ({
      id: item.id,
      position: idx,
      createdAt: item.createdAt,
      image: serializeImageAsset(item.asset ?? null, options),
    }));
}

export interface SerializedUserImages {
  avatar: AvatarSerialization | null;
}

export function serializeUserImages(user: IUser): SerializedUserImages {
  return {
    avatar: serializeAvatar(user.avatar ?? null),
  };
}

/**
 * For Stream Chat upserts: returns the medium-sized Cloudflare avatar URL.
 * Returns `undefined` when no avatar is configured (callers fall back to
 * preset).
 */
export function pickStreamAvatarUrl(user: IUser, creator?: ICreator | null): string | undefined {
  if (creator?.avatar) {
    const view = serializeAvatar(creator.avatar);
    if (view) return view.avatarUrls.md;
  }
  if (user.avatar) {
    const view = serializeAvatar(user.avatar);
    if (view) return view.avatarUrls.md;
  }
  return undefined;
}
