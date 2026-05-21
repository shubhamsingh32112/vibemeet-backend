import type { ICreator } from './creator.model';
import type { IUser } from '../user/user.model';
import {
  serializeCreatorImages,
  serializeUserImages,
  type SerializedGalleryItem,
} from '../images/creator-image-helpers';
import type { AvatarSerialization } from '../images/serialize-image-asset';

/** Flat gallery row for staff portals (agency / BD / admin). */
export type StaffPortalGalleryImage = {
  id: string;
  url: string;
  position: number;
  createdAt: string;
};

export function pickPrimaryAvatarUrl(avatar: AvatarSerialization | null | undefined): string | null {
  if (!avatar?.avatarUrls) return null;
  return avatar.avatarUrls.md ?? avatar.avatarUrls.sm ?? avatar.avatarUrls.xs ?? null;
}

export function galleryToStaffDtos(items: SerializedGalleryItem[]): StaffPortalGalleryImage[] {
  const out: StaffPortalGalleryImage[] = [];
  for (const item of items) {
    const url =
      item.image?.galleryUrls?.md ??
      item.image?.galleryUrls?.xl ??
      item.image?.galleryUrls?.thumb ??
      null;
    if (!url) continue;
    out.push({
      id: item.id,
      url,
      position: item.position,
      createdAt:
        item.createdAt instanceof Date
          ? item.createdAt.toISOString()
          : new Date(item.createdAt).toISOString(),
    });
  }
  return out;
}

export function buildCreatorMediaPayload(
  creator: Pick<ICreator, 'avatar' | 'galleryImages'>
): {
  avatar: AvatarSerialization | null;
  avatarUrl: string | null;
  /** @deprecated Legacy field — same URL as avatarUrl when Cloudflare avatar exists. */
  photo: string | null;
  galleryImages: StaffPortalGalleryImage[];
  galleryCount: number;
} {
  const images = serializeCreatorImages(creator as ICreator);
  const avatarUrl = pickPrimaryAvatarUrl(images.avatar);
  const galleryImages = galleryToStaffDtos(images.galleryImages);
  return {
    avatar: images.avatar,
    avatarUrl,
    photo: avatarUrl,
    galleryImages,
    galleryCount: galleryImages.length,
  };
}

export function buildUserMediaPayload(user: IUser): {
  avatar: AvatarSerialization | null;
  avatarUrl: string | null;
} {
  const images = serializeUserImages(user);
  const avatarUrl = pickPrimaryAvatarUrl(images.avatar);
  return { avatar: images.avatar, avatarUrl };
}
