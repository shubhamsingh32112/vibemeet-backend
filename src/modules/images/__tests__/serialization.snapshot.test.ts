/**
 * Serialization snapshot tests for image asset payloads.
 *
 * Goal: lock the public shape AND host of every image URL the backend emits
 * so a contract drift fails CI instead of silently shipping a bad client
 * payload. These tests pin:
 *   - serializeImageAsset (gallery + avatar shape)
 *   - serializeAvatar    (avatar slice)
 *   - serializeCreatorImages / serializeCreatorGallery (full creator payload)
 *   - serializeUserImages / pickStreamAvatarUrl (user-side serializers)
 *   - URL host invariant: every URL MUST originate from imagedelivery.net
 *
 * Run with: `npm test` (already wired in package.json).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Snapshot tests run against a deterministic Cloudflare config.
const TEST_ACCOUNT_HASH = 'test-account-hash-1234567890abcdef';
process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account-id';
process.env.CLOUDFLARE_ACCOUNT_HASH = TEST_ACCOUNT_HASH;
process.env.CLOUDFLARE_IMAGES_API_TOKEN = 'test-api-token';
process.env.CLOUDFLARE_IMAGES_DELIVERY_HOST = 'imagedelivery.net';

import { __resetCloudflareConfigForTests } from '../../../config/cloudflare';
import {
  serializeImageAsset,
  serializeAvatar,
  type ImageAssetView,
  type AvatarSerialization,
} from '../serialize-image-asset';
import {
  serializeCreatorImages,
  serializeCreatorGallery,
  serializeUserImages,
  pickStreamAvatarUrl,
} from '../creator-image-helpers';
import type { IImageAsset } from '../image-asset.schema';
import type { ICreator, ICreatorGalleryImage } from '../../creator/creator.model';
import type { IUser } from '../../user/user.model';

__resetCloudflareConfigForTests();

// ── Fixtures ─────────────────────────────────────────────────────────────
const FIXED_DATE = new Date('2025-01-15T10:30:00.000Z');
const ASSET_AVATAR_OK: IImageAsset = {
  imageId: 'img-avatar-001',
  uploadedBy: null,
  width: 1024,
  height: 1024,
  blurhash: 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH',
  mimeType: 'image/jpeg',
  moderationStatus: 'auto-ok',
  createdAt: FIXED_DATE,
};
const ASSET_GALLERY_APPROVED: IImageAsset = {
  imageId: 'img-gallery-002',
  uploadedBy: null,
  width: 1600,
  height: 1200,
  blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
  mimeType: 'image/jpeg',
  moderationStatus: 'approved',
  createdAt: FIXED_DATE,
};
const ASSET_PENDING: IImageAsset = {
  ...ASSET_AVATAR_OK,
  imageId: 'img-pending-003',
  moderationStatus: 'pending',
};
const ASSET_REJECTED: IImageAsset = {
  ...ASSET_AVATAR_OK,
  imageId: 'img-rejected-004',
  moderationStatus: 'rejected',
};

const CF_HOST_PREFIX = `https://imagedelivery.net/${TEST_ACCOUNT_HASH}/`;

function assertImageDeliveryUrl(value: unknown, ctx: string): void {
  assert.equal(typeof value, 'string', `${ctx}: expected string URL`);
  assert.ok(
    (value as string).startsWith(CF_HOST_PREFIX),
    `${ctx}: URL must come from imagedelivery.net (got: ${value})`,
  );
}

function collectStringUrls(obj: unknown, out: Array<[string, string]>, path: string = ''): void {
  if (obj == null) return;
  if (typeof obj === 'string') {
    if (obj.startsWith('http')) out.push([path, obj]);
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => collectStringUrls(item, out, `${path}[${i}]`));
    return;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      collectStringUrls(v, out, path ? `${path}.${k}` : k);
    }
  }
}

// ── serializeImageAsset ──────────────────────────────────────────────────
test('serializeImageAsset(auto-ok) emits full ImageAssetView with deterministic CF URLs', () => {
  const view = serializeImageAsset(ASSET_AVATAR_OK);
  assert.deepEqual(view, {
    imageId: 'img-avatar-001',
    width: 1024,
    height: 1024,
    blurhash: 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH',
    avatarUrls: {
      xs: `${CF_HOST_PREFIX}img-avatar-001/avatarXs`,
      sm: `${CF_HOST_PREFIX}img-avatar-001/avatarSm`,
      md: `${CF_HOST_PREFIX}img-avatar-001/avatarMd`,
      feedTile: `${CF_HOST_PREFIX}img-avatar-001/feedTile`,
      callPhoto: `${CF_HOST_PREFIX}img-avatar-001/callPhoto`,
      callBg: `${CF_HOST_PREFIX}img-avatar-001/callBg`,
    },
    galleryUrls: {
      thumb: `${CF_HOST_PREFIX}img-avatar-001/galleryThumb`,
      md: `${CF_HOST_PREFIX}img-avatar-001/galleryMd`,
      xl: `${CF_HOST_PREFIX}img-avatar-001/galleryXl`,
    },
  } satisfies ImageAssetView);
});

test('serializeImageAsset filters rejected and pending (without override) to null', () => {
  assert.equal(serializeImageAsset(ASSET_REJECTED), null);
  assert.equal(serializeImageAsset(ASSET_PENDING), null);
});

test('serializeImageAsset(includePending=true) returns view for pending assets', () => {
  const view = serializeImageAsset(ASSET_PENDING, { includePending: true });
  assert.ok(view, 'pending asset must serialize when includePending=true');
  assert.equal(view.imageId, 'img-pending-003');
});

test('serializeImageAsset(null|undefined|empty imageId) returns null', () => {
  assert.equal(serializeImageAsset(null), null);
  assert.equal(serializeImageAsset(undefined), null);
  assert.equal(
    serializeImageAsset({ ...ASSET_AVATAR_OK, imageId: '' }),
    null,
  );
});

// ── serializeAvatar ──────────────────────────────────────────────────────
test('serializeAvatar emits avatar-only slice (no galleryUrls)', () => {
  const slice = serializeAvatar(ASSET_AVATAR_OK);
  assert.deepEqual(slice, {
    imageId: 'img-avatar-001',
    blurhash: 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH',
    width: 1024,
    height: 1024,
    avatarUrls: {
      xs: `${CF_HOST_PREFIX}img-avatar-001/avatarXs`,
      sm: `${CF_HOST_PREFIX}img-avatar-001/avatarSm`,
      md: `${CF_HOST_PREFIX}img-avatar-001/avatarMd`,
      feedTile: `${CF_HOST_PREFIX}img-avatar-001/feedTile`,
      callPhoto: `${CF_HOST_PREFIX}img-avatar-001/callPhoto`,
      callBg: `${CF_HOST_PREFIX}img-avatar-001/callBg`,
    },
  } satisfies AvatarSerialization);
  // Avatar slice MUST NOT leak galleryUrls (those are bandwidth heavy).
  assert.equal(
    'galleryUrls' in (slice as object),
    false,
    'avatar slice must not include galleryUrls',
  );
});

// ── serializeCreatorImages ───────────────────────────────────────────────
test('serializeCreatorImages emits {avatar, galleryImages} with sorted positions', () => {
  const creator = {
    avatar: ASSET_AVATAR_OK,
    galleryImages: [
      {
        id: 'g-2',
        asset: ASSET_GALLERY_APPROVED,
        position: 1,
        createdAt: FIXED_DATE,
      } as ICreatorGalleryImage,
      {
        id: 'g-1',
        asset: ASSET_AVATAR_OK,
        position: 0,
        createdAt: FIXED_DATE,
      } as ICreatorGalleryImage,
    ],
  } as unknown as ICreator;

  const out = serializeCreatorImages(creator);
  assert.deepEqual(out, {
    avatar: serializeAvatar(ASSET_AVATAR_OK),
    galleryImages: [
      {
        id: 'g-1',
        position: 0,
        createdAt: FIXED_DATE,
        image: serializeImageAsset(ASSET_AVATAR_OK),
      },
      {
        id: 'g-2',
        position: 1,
        createdAt: FIXED_DATE,
        image: serializeImageAsset(ASSET_GALLERY_APPROVED),
      },
    ],
  });
});

test('serializeCreatorImages no longer ships legacyPhoto (Phase E removed it)', () => {
  const creator = {
    avatar: ASSET_AVATAR_OK,
    galleryImages: [],
  } as unknown as ICreator;
  const out = serializeCreatorImages(creator);
  assert.equal(
    'legacyPhoto' in (out as object),
    false,
    'legacyPhoto must not appear in the serialized payload',
  );
});

test('serializeCreatorImages returns avatar:null when avatar is rejected', () => {
  const creator = {
    avatar: ASSET_REJECTED,
    galleryImages: [],
  } as unknown as ICreator;
  const out = serializeCreatorImages(creator);
  assert.equal(out.avatar, null);
});

// ── serializeCreatorGallery sort stability ──────────────────────────────
test('serializeCreatorGallery uses createdAt as tiebreaker when positions match', () => {
  const earlier = new Date('2025-01-01T00:00:00.000Z');
  const later = new Date('2025-02-01T00:00:00.000Z');
  const items = [
    { id: 'late', asset: ASSET_AVATAR_OK, position: 5, createdAt: later } as ICreatorGalleryImage,
    { id: 'early', asset: ASSET_AVATAR_OK, position: 5, createdAt: earlier } as ICreatorGalleryImage,
  ];
  const out = serializeCreatorGallery(items);
  assert.deepEqual(
    out.map((row) => row.id),
    ['early', 'late'],
    'earlier createdAt wins when positions tie',
  );
  assert.equal(out[0].position, 0, 'positions reflow to 0..N');
  assert.equal(out[1].position, 1, 'positions reflow to 0..N');
});

// ── serializeUserImages / pickStreamAvatarUrl ────────────────────────────
test('serializeUserImages returns Cloudflare avatar when user.avatar is IImageAsset', () => {
  const user = { avatar: ASSET_AVATAR_OK } as unknown as IUser;
  const out = serializeUserImages(user);
  assert.deepEqual(out, {
    avatar: serializeAvatar(ASSET_AVATAR_OK),
  });
  assert.equal(
    'legacyAvatarUrl' in (out as object),
    false,
    'legacyAvatarUrl must not appear in serialized payload (Phase E)',
  );
});

test('serializeUserImages returns null when user.avatar is missing', () => {
  const user = { avatar: null } as unknown as IUser;
  const out = serializeUserImages(user);
  assert.deepEqual(out, { avatar: null });
});

test('pickStreamAvatarUrl prefers creator Cloudflare avatar', () => {
  const creator = { avatar: ASSET_AVATAR_OK } as unknown as ICreator;
  const user = { avatar: null } as unknown as IUser;
  const url = pickStreamAvatarUrl(user, creator);
  assert.equal(url, `${CF_HOST_PREFIX}img-avatar-001/avatarMd`);
});

test('pickStreamAvatarUrl falls back to user Cloudflare avatar when no creator avatar', () => {
  const user = { avatar: ASSET_AVATAR_OK } as unknown as IUser;
  const url = pickStreamAvatarUrl(user, null);
  assert.equal(url, `${CF_HOST_PREFIX}img-avatar-001/avatarMd`);
});

test('pickStreamAvatarUrl returns undefined when neither has an avatar', () => {
  const user = { avatar: null } as unknown as IUser;
  const url = pickStreamAvatarUrl(user, null);
  assert.equal(url, undefined);
});

// ── URL host invariant: every emitted Cloudflare URL must use imagedelivery.net ──
test('URL host invariant — serializeImageAsset', () => {
  const view = serializeImageAsset(ASSET_AVATAR_OK)!;
  const urls: Array<[string, string]> = [];
  collectStringUrls({ avatarUrls: view.avatarUrls, galleryUrls: view.galleryUrls }, urls);
  assert.ok(urls.length >= 9, `expected ≥9 URLs, got ${urls.length}`);
  for (const [path, url] of urls) {
    assertImageDeliveryUrl(url, path);
  }
});

test('URL host invariant — serializeCreatorImages', () => {
  const creator = {
    avatar: ASSET_AVATAR_OK,
    galleryImages: [
      { id: 'g-1', asset: ASSET_GALLERY_APPROVED, position: 0, createdAt: FIXED_DATE } as ICreatorGalleryImage,
    ],
  } as unknown as ICreator;
  const out = serializeCreatorImages(creator);
  const urls: Array<[string, string]> = [];
  collectStringUrls(out, urls);
  assert.ok(urls.length > 0, 'expected URLs in serialized creator payload');
  for (const [path, url] of urls) {
    assertImageDeliveryUrl(url, path);
  }
});

// ── Path shape lock: variant name MUST match enum ────────────────────────
test('Path shape lock — every CF URL ends with /<imageId>/<known-variant>', () => {
  const view = serializeImageAsset(ASSET_AVATAR_OK)!;
  const knownVariants = new Set([
    'avatarXs',
    'avatarSm',
    'avatarMd',
    'feedTile',
    'callPhoto',
    'callBg',
    'galleryThumb',
    'galleryMd',
    'galleryXl',
    'public',
  ]);
  const all = [
    ...Object.values(view.avatarUrls),
    ...Object.values(view.galleryUrls),
  ];
  for (const url of all) {
    const tail = url.split('/').pop();
    assert.ok(
      tail && knownVariants.has(tail),
      `unexpected variant in URL: ${url} (tail=${tail})`,
    );
  }
});
