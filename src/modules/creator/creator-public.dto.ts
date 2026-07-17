import type {
  AvatarSerialization,
  ImageAssetView,
} from '../images/serialize-image-asset';
import type { SerializedGalleryItem } from '../images/creator-image-helpers';
import type { AvatarUrls, GalleryUrls } from '../images/image-url';

export type PublicCreatorAvailability = 'online' | 'on_call' | 'offline';

export type PublicAvatarAsset = {
  urls: AvatarUrls;
  width: number | null;
  height: number | null;
  blurhash: string | null;
};

export type PublicGalleryAsset = {
  position: number;
  image: {
    urls: GalleryUrls;
    width: number | null;
    height: number | null;
    blurhash: string | null;
  };
};

export type PublicCreatorDto = {
  id: string;
  name: string;
  about: string;
  categories: string[];
  avatar: PublicAvatarAsset | null;
  gallery: PublicGalleryAsset[];
  price: number;
  age?: number;
  location?: string;
  availability: PublicCreatorAvailability;
};

type PublicCreatorSource = {
  id: string;
  name: string;
  about?: string | null;
  categories?: string[] | null;
  price: number;
  age?: number;
  location?: string;
};

function toPublicAvatar(avatar: AvatarSerialization | null): PublicAvatarAsset | null {
  if (!avatar) return null;
  return {
    urls: avatar.avatarUrls,
    width: avatar.width,
    height: avatar.height,
    blurhash: avatar.blurhash,
  };
}

function toPublicGalleryImage(image: ImageAssetView): PublicGalleryAsset['image'] {
  return {
    urls: image.galleryUrls,
    width: image.width,
    height: image.height,
    blurhash: image.blurhash,
  };
}

/** Explicit allowlist boundary for unauthenticated creator discovery. */
export function toPublicCreatorDto(
  creator: PublicCreatorSource,
  images: { avatar: AvatarSerialization | null; galleryImages: SerializedGalleryItem[] },
  availability: PublicCreatorAvailability,
): PublicCreatorDto {
  return {
    id: creator.id,
    name: creator.name,
    about: creator.about ?? '',
    categories: creator.categories ?? [],
    avatar: toPublicAvatar(images.avatar),
    gallery: images.galleryImages.flatMap((item) =>
      item.image
        ? [{ position: item.position, image: toPublicGalleryImage(item.image) }]
        : [],
    ),
    price: creator.price,
    ...(creator.age === undefined ? {} : { age: creator.age }),
    ...(creator.location === undefined ? {} : { location: creator.location }),
    availability,
  };
}
