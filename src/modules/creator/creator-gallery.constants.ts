export const CREATOR_GALLERY_MAX_IMAGES = 6;
export const CREATOR_GALLERY_MIN_IMAGES = 1;
export const CREATOR_GALLERY_UPLOAD_URL_TTL_MINUTES = 10;
export const CREATOR_GALLERY_ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
] as const;

export type CreatorGalleryContentType =
  (typeof CREATOR_GALLERY_ALLOWED_CONTENT_TYPES)[number];
