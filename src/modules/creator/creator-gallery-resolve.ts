import { buildPublicGalleryDownloadUrl } from './creator-gallery.storage';
import { logWarning } from '../../utils/logger';

export type NormalizedGalleryImage = {
  id: string;
  url: string;
  storagePath: string;
  position: number;
  createdAt: Date;
  thumbnailUrl?: string;
};

export function normalizeGalleryImages(
  galleryImages: Array<{
    id: string;
    url: string;
    storagePath: string;
    position: number;
    createdAt: Date;
    thumbnailUrl?: string | null;
  }> = [],
): NormalizedGalleryImage[] {
  return [...galleryImages]
    .sort((a, b) => a.position - b.position || +new Date(a.createdAt) - +new Date(b.createdAt))
    .map((image, idx): NormalizedGalleryImage => {
      const row: NormalizedGalleryImage = {
        id: image.id,
        url: image.url,
        storagePath: image.storagePath,
        position: idx,
        createdAt: image.createdAt,
      };
      const t = image.thumbnailUrl;
      if (typeof t === 'string' && t.trim().length > 0) {
        row.thumbnailUrl = t.trim();
      }
      return row;
    });
}

/** Fix legacy gallery URLs missing Firebase download tokens (403 in mobile clients). */
export async function resolveGalleryImageUrlsForApi(
  galleryImages: Parameters<typeof normalizeGalleryImages>[0],
): Promise<{ galleryImages: ReturnType<typeof normalizeGalleryImages>; urlsChanged: boolean }> {
  const normalized = normalizeGalleryImages(galleryImages);
  let urlsChanged = false;
  const resolved = await Promise.all(
    normalized.map(async (img) => {
      if (!img.storagePath || img.url.includes('token=')) {
        return img;
      }
      try {
        const url = await buildPublicGalleryDownloadUrl(img.storagePath);
        if (url !== img.url) urlsChanged = true;
        return { ...img, url, thumbnailUrl: img.thumbnailUrl };
      } catch (e) {
        logWarning('Failed to resolve gallery download URL', {
          storagePath: img.storagePath,
          error: e instanceof Error ? e.message : String(e),
        });
        return img;
      }
    }),
  );
  return {
    galleryImages: normalizeGalleryImages(resolved),
    urlsChanged,
  };
}
