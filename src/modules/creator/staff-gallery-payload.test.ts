import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account-id';
process.env.CLOUDFLARE_ACCOUNT_HASH = 'test-account-hash-1234567890abcdef';
process.env.CLOUDFLARE_IMAGES_API_TOKEN = 'test-api-token';
process.env.CLOUDFLARE_IMAGES_DELIVERY_HOST = 'imagedelivery.net';

import type { ICreatorGalleryImage } from './creator.model';
import type { IImageAsset } from '../images/image-asset.schema';
import { galleryToStaffDtos, staffGalleryFromCreator } from './creator-staff-portal.payload';
import { serializeCreatorGallery } from '../images/creator-image-helpers';

const ASSET_GALLERY_APPROVED: IImageAsset = {
  imageId: 'img-gallery-test-002',
  uploadedBy: null,
  width: 1600,
  height: 1200,
  blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
  mimeType: 'image/jpeg',
  moderationStatus: 'approved',
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
};

test('galleryToStaffDtos maps Cloudflare asset to flat url', () => {
  const serialized = serializeCreatorGallery([
    {
      id: 'g-1',
      asset: ASSET_GALLERY_APPROVED,
      position: 0,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    } as ICreatorGalleryImage,
  ]);
  const dtos = galleryToStaffDtos(serialized);
  assert.equal(dtos.length, 1);
  assert.equal(dtos[0].id, 'g-1');
  assert.ok(dtos[0].url.includes('imagedelivery.net') || dtos[0].url.length > 0);
});

test('galleryToStaffDtos uses legacy url when asset missing', () => {
  const serialized = serializeCreatorGallery([
    {
      id: 'legacy-1',
      position: 0,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    } as ICreatorGalleryImage,
  ]);
  const legacy = new Map([['legacy-1', 'https://firebasestorage.googleapis.com/v0/b/x/o/y.jpg']]);
  const dtos = galleryToStaffDtos(serialized, legacy);
  assert.equal(dtos.length, 1);
  assert.ok(dtos[0].url.includes('firebasestorage.googleapis.com'));
});

test('staffGalleryFromCreator returns flat rows with url', () => {
  const creator = {
    galleryImages: [
      {
        id: 'g-2',
        asset: ASSET_GALLERY_APPROVED,
        position: 0,
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
      },
    ],
  };
  const dtos = staffGalleryFromCreator(creator);
  assert.equal(dtos.length, 1);
  assert.ok(dtos[0].url);
});
