/**
 * Single source of truth for Cloudflare Images delivery URLs.
 *
 * Frontend NEVER constructs URLs. Backend serializes every read path to
 *   - AvatarUrls (xs, sm, md, callPhoto, callBg) — no `original` exposure
 *   - GalleryUrls (thumb, md, xl)                — `xl` is the public ceiling
 *
 * Delivery format: https://imagedelivery.net/<ACCOUNT_HASH>/<IMAGE_ID>/<VARIANT>
 *
 * `original`/`public` is reserved for admin tooling via buildAdminOriginalUrl.
 */

import { getCloudflareConfig } from '../../config/cloudflare';

// IMPORTANT: Cloudflare Images rejects variant names that contain `-` or `_`
// (HTTP 400, code 5400, "Variant name `…` is not allowed"). Names MUST be
// alphanumeric only. We use camelCase here so the URL path segment mirrors
// the camelCase getter names on `AvatarUrls` / `GalleryUrls` (e.g.
// `urls.feedTile` resolves to a URL ending in `/feedTile`).
export type ImageVariant =
  | 'avatarXs'
  | 'avatarSm'
  | 'avatarMd'
  | 'feedTile'
  | 'callPhoto'
  | 'callBg'
  | 'galleryThumb'
  | 'galleryMd'
  | 'galleryXl'
  | 'public';

export interface AvatarUrls {
  xs: string;
  sm: string;
  md: string;
  feedTile: string;
  callPhoto: string;
  callBg: string;
}

export interface GalleryUrls {
  thumb: string;
  md: string;
  xl: string;
}

export interface CloudflareImageRef {
  imageId: string;
  width?: number | null;
  height?: number | null;
  blurhash?: string | null;
}

/**
 * Build a single delivery URL for a Cloudflare imageId + variant.
 * Throws when imageId is missing — callers MUST handle the null-asset case
 * upstream (e.g. fall back to preset placeholder).
 */
export function buildCloudflareImageUrl(imageId: string, variant: ImageVariant): string {
  if (!imageId || typeof imageId !== 'string') {
    throw new Error('buildCloudflareImageUrl: imageId is required');
  }
  const { accountHash, deliveryHost } = getCloudflareConfig();
  return `https://${deliveryHost}/${accountHash}/${imageId}/${variant}`;
}

/**
 * Build the full Avatar variant set.
 * IMPORTANT: deliberately omits `original`. Avatars are NEVER served at
 * source bytes — `callBg` is the largest exposure.
 */
export function buildAvatarUrls(imageId: string): AvatarUrls {
  return {
    xs: buildCloudflareImageUrl(imageId, 'avatarXs'),
    sm: buildCloudflareImageUrl(imageId, 'avatarSm'),
    md: buildCloudflareImageUrl(imageId, 'avatarMd'),
    feedTile: buildCloudflareImageUrl(imageId, 'feedTile'),
    callPhoto: buildCloudflareImageUrl(imageId, 'callPhoto'),
    callBg: buildCloudflareImageUrl(imageId, 'callBg'),
  };
}

/**
 * Build the full Gallery variant set.
 * `xl` is the publicly-served ceiling (1600px scale-down).
 * True `original` is admin-only via buildAdminOriginalUrl.
 */
export function buildGalleryUrls(imageId: string): GalleryUrls {
  return {
    thumb: buildCloudflareImageUrl(imageId, 'galleryThumb'),
    md: buildCloudflareImageUrl(imageId, 'galleryMd'),
    xl: buildCloudflareImageUrl(imageId, 'galleryXl'),
  };
}

/**
 * Admin-only: returns the `public` variant (effectively the original).
 * Do NOT leak this into any mobile or web client response.
 */
export function buildAdminOriginalUrl(imageId: string): string {
  return buildCloudflareImageUrl(imageId, 'public');
}

export function buildCallBgUrl(imageId: string): string {
  return buildCloudflareImageUrl(imageId, 'callBg');
}
