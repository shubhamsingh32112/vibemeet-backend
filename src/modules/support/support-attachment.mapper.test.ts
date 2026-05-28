import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapSupportAttachmentForApi } from './support-attachment.mapper';

test('mapSupportAttachmentForApi prefers Cloudflare url over base64 in list responses', () => {
  const mapped = mapSupportAttachmentForApi({
    name: 'shot.png',
    mimeType: 'image/png',
    sizeBytes: 1200,
    isScreenshot: false,
    imageId: 'cf-img-1',
    url: 'https://imagedelivery.net/hash/cf-img-1/galleryMd',
    dataBase64: 'abc',
  });
  assert.equal(mapped.url, 'https://imagedelivery.net/hash/cf-img-1/galleryMd');
  assert.equal(mapped.dataBase64, undefined);
  assert.equal(mapped.dataUrl, 'data:image/png;base64,abc');
});

test('mapSupportAttachmentForApi legacy base64 only', () => {
  const mapped = mapSupportAttachmentForApi({
    name: 'legacy.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 500,
    isScreenshot: true,
    dataBase64: 'Zm9v',
  });
  assert.equal(mapped.url, undefined);
  assert.equal(mapped.dataUrl, 'data:image/jpeg;base64,Zm9v');
});
