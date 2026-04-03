import crypto from 'node:crypto';
import { getFirebaseAdmin } from '../../config/firebase';
import {
  CREATOR_GALLERY_ALLOWED_CONTENT_TYPES,
  CREATOR_GALLERY_UPLOAD_URL_TTL_MINUTES,
  type CreatorGalleryContentType,
} from './creator-gallery.constants';

const GALLERY_PATH_REGEX = /^creators\/([a-fA-F0-9]{24})\/gallery\/([a-fA-F0-9-]+)\.jpg$/;

export function getStorageBucketName(): string {
  const explicitBucket = process.env.FIREBASE_STORAGE_BUCKET?.trim();
  if (explicitBucket) return explicitBucket;

  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  if (!projectId) {
    throw new Error('Missing FIREBASE_PROJECT_ID for Firebase Storage bucket resolution');
  }
  return `${projectId}.firebasestorage.app`;
}

function getBucket() {
  const admin = getFirebaseAdmin();
  return admin.storage().bucket(getStorageBucketName());
}

export interface CreatorGallerySignedUpload {
  uploadUrl: string;
  storagePath: string;
  imageId: string;
  expiresAt: string;
  contentType: CreatorGalleryContentType;
}

export function isAllowedGalleryContentType(value: unknown): value is CreatorGalleryContentType {
  return (
    typeof value === 'string' &&
    CREATOR_GALLERY_ALLOWED_CONTENT_TYPES.includes(value as CreatorGalleryContentType)
  );
}

export function buildGalleryStoragePath(creatorId: string, imageId?: string): string {
  const finalImageId = imageId ?? crypto.randomUUID();
  return `creators/${creatorId}/gallery/${finalImageId}.jpg`;
}

export function parseGalleryStoragePath(path: string): { creatorId: string; imageId: string } | null {
  const match = GALLERY_PATH_REGEX.exec(path);
  if (!match) return null;
  return { creatorId: match[1], imageId: match[2] };
}

export async function createCreatorGallerySignedUpload(
  creatorId: string,
  contentType: CreatorGalleryContentType,
): Promise<CreatorGallerySignedUpload> {
  const imageId = crypto.randomUUID();
  const storagePath = buildGalleryStoragePath(creatorId, imageId);
  const expiresAtDate = new Date(
    Date.now() + CREATOR_GALLERY_UPLOAD_URL_TTL_MINUTES * 60 * 1000,
  );

  const [uploadUrl] = await getBucket().file(storagePath).getSignedUrl({
    version: 'v4',
    action: 'write',
    expires: expiresAtDate,
    contentType,
  });

  return {
    uploadUrl,
    storagePath,
    imageId,
    expiresAt: expiresAtDate.toISOString(),
    contentType,
  };
}

export async function deleteGalleryStorageObject(storagePath: string): Promise<void> {
  await getBucket().file(storagePath).delete({ ignoreNotFound: true });
}

/**
 * Firebase client URLs need `firebaseStorageDownloadTokens` for typical Storage rules.
 * Unsigned `?alt=media` alone returns 403 from the app. This ensures metadata + token URL.
 */
export async function buildPublicGalleryDownloadUrl(storagePath: string): Promise<string> {
  const bucketName = getStorageBucketName();
  const file = getBucket().file(storagePath);
  const [exists] = await file.exists();
  if (!exists) {
    throw new Error(`Gallery object not found: ${storagePath}`);
  }

  const [meta] = await file.getMetadata();
  const existingRaw = meta.metadata?.firebaseStorageDownloadTokens;
  let token: string;
  if (typeof existingRaw === 'string' && existingRaw.trim().length > 0) {
    token = existingRaw.split(',')[0].trim();
  } else {
    token = crypto.randomUUID();
    await file.setMetadata({
      metadata: {
        ...(meta.metadata || {}),
        firebaseStorageDownloadTokens: token,
      },
      cacheControl: 'public, max-age=31536000, immutable',
    });
  }

  return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(
    bucketName,
  )}/o/${encodeURIComponent(storagePath)}?alt=media&token=${encodeURIComponent(token)}`;
}
