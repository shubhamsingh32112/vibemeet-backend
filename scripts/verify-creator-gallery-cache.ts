/**
 * Verification script for creator detail gallery cache bug.
 * Simulates cache WRITE (serialized API doc) vs cache READ (re-serialize).
 *
 * Run: npx tsx scripts/verify-creator-gallery-cache.ts
 */
import { serializeCreatorGallery, serializeCreatorImages } from '../src/modules/images/creator-image-helpers';
import type { ICreator, ICreatorGalleryImage } from '../src/modules/creator/creator.model';

const ASSET_GALLERY_APPROVED = {
  imageId: 'cf-test-gallery-image-id',
  width: 800,
  height: 600,
  blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
  moderationStatus: 'approved' as const,
};

const mongoGalleryImages: ICreatorGalleryImage[] = [
  {
    id: 'gallery-slot-1',
    asset: ASSET_GALLERY_APPROVED,
    position: 0,
    createdAt: new Date('2025-06-01T00:00:00.000Z'),
  },
];

function summarizeGallery(galleryImages: Array<{ id: string; image: unknown }>) {
  return galleryImages.map((item) => ({
    id: item.id,
    imageIsNull: item.image === null,
    hasGalleryUrls: Boolean(
      item.image &&
        typeof item.image === 'object' &&
        'galleryUrls' in item.image &&
        (item.image as { galleryUrls?: { thumb?: string } }).galleryUrls?.thumb,
    ),
    thumbPreview:
      item.image &&
      typeof item.image === 'object' &&
      'galleryUrls' in item.image
        ? (item.image as { galleryUrls?: { thumb?: string } }).galleryUrls?.thumb?.slice(0, 60)
        : null,
  }));
}

console.log('=== Step 1: Cache MISS path (Mongo → serializeCreatorGallery) ===');
const missGalleryImages = serializeCreatorGallery(mongoGalleryImages);
console.log(JSON.stringify(summarizeGallery(missGalleryImages), null, 2));

console.log('\n=== Step 2: Cache WRITE shape (what Redis stores) ===');
const cacheDoc = {
  v: 1,
  id: 'creator-id-example',
  galleryImages: missGalleryImages,
};
console.log('cacheDoc.galleryImages[0] keys:', Object.keys(cacheDoc.galleryImages[0] ?? {}));
console.log('has .image?', 'image' in (cacheDoc.galleryImages[0] ?? {}));
console.log('has .asset?', 'asset' in (cacheDoc.galleryImages[0] ?? {}));

console.log('\n=== Step 3: Cache HIT path (current code — re-serialize cached doc) ===');
const galleryRaw = cacheDoc.galleryImages;
const hitGalleryImagesBuggy = Array.isArray(galleryRaw)
  ? serializeCreatorGallery(galleryRaw as unknown as ICreatorGalleryImage[])
  : [];
console.log(JSON.stringify(summarizeGallery(hitGalleryImagesBuggy), null, 2));

console.log('\n=== Step 4: Cache HIT path (proposed fix — pass through) ===');
const hitGalleryImagesFixed = Array.isArray(galleryRaw) ? galleryRaw : [];
console.log(JSON.stringify(summarizeGallery(hitGalleryImagesFixed), null, 2));

console.log('\n=== Verdict ===');
const missOk = missGalleryImages.some((i) => i.image !== null);
const hitBuggyBroken = hitGalleryImagesBuggy.every((i) => i.image === null);
const hitFixedOk = hitGalleryImagesFixed.some((i) => i.image !== null);

if (missOk && hitBuggyBroken && hitFixedOk) {
  console.log('CONFIRMED: Cache miss has images; cache hit re-serialization nulls all image fields.');
  console.log('This matches API pattern: galleryImages with items but image:null on cache hit.');
} else {
  console.log('UNEXPECTED: missOk=%s hitBuggyBroken=%s hitFixedOk=%s', missOk, hitBuggyBroken, hitFixedOk);
}

// Full serializeCreatorImages for completeness
const creator = { avatar: null, galleryImages: mongoGalleryImages } as unknown as ICreator;
const images = serializeCreatorImages(creator);
console.log('\n=== serializeCreatorImages (miss path helper) ===');
console.log(JSON.stringify(summarizeGallery(images.galleryImages), null, 2));
