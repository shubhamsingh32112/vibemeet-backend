/**
 * Shared commit pipeline for ALL image-asset writes (creator avatar,
 * creator gallery item, user avatar).
 *
 * Steps (per plan §6.5):
 *   1. Consume the Redis upload session (single-shot; ownership-bound).
 *   2. Ask Cloudflare for object metadata (dims, validate that bytes exist).
 *   3. Server-side MIME sniff (rejects non-image bytes the client lied about).
 *   4. Record the upload against the per-user quota.
 *   5. Build the IImageAsset (moderation state per env flag).
 *   6. Enqueue async blurhash job (NEVER blocks the response).
 *
 * Returns the prepared `IImageAsset` for the caller to embed in the
 * owning Mongo document.
 */

import type { Types } from 'mongoose';
import {
  consumeSession,
  type UploadPurpose,
  type UploadSession,
} from './upload-session.service';
import {
  getImageMetadata,
  CloudflareImagesError,
  deleteImage,
} from './cloudflare.client';
import { sniffImageMime, UnsupportedMimeTypeError } from './mime-sniff.service';
import { recordUpload, type QuotaScope } from './upload-quota.service';
import { enqueueBlurhashJob, type BlurhashJobData } from './blurhash.queue';
import { makeImageAssetDoc, type IImageAsset } from './image-asset.schema';
import {
  isImageModerationPendingByDefault,
} from '../../config/cloudflare';
import { logWarning, logInfo } from '../../utils/logger';
import { bumpImageCounter } from './image-metrics';

export class CommitImageAssetError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status: number = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface CommitImageAssetInput {
  sessionId: string;
  userId: string;
  userObjectId: Types.ObjectId;
  purpose: UploadPurpose;
  quotaScope: QuotaScope;
  blurhashTarget: BlurhashJobData['target'];
  requestId?: string;
}

export interface CommitImageAssetResult {
  asset: IImageAsset;
  session: UploadSession;
}

export async function commitImageAsset(
  input: CommitImageAssetInput,
): Promise<CommitImageAssetResult> {
  const session = await consumeSession(input.sessionId, input.userId, input.purpose);
  if (!session) {
    throw new CommitImageAssetError(
      'UPLOAD_SESSION_INVALID',
      'upload session not found, expired, or owned by another user',
      400,
    );
  }

  // Steps 2 + 3: validate Cloudflare actually has the bytes and they're a real image.
  let metadata: Awaited<ReturnType<typeof getImageMetadata>>;
  try {
    metadata = await getImageMetadata(session.imageId);
  } catch (error) {
    if (error instanceof CloudflareImagesError && error.status === 404) {
      bumpImageCounter('commit.cloudflare_missing', { purpose: input.purpose });
      throw new CommitImageAssetError(
        'UPLOAD_NOT_FOUND',
        'cloudflare reports no bytes for this upload — did the client finish?',
        400,
      );
    }
    throw error;
  }

  let mimeType: string;
  try {
    const sniff = await sniffImageMime(session.imageId);
    mimeType = sniff.mime;
  } catch (error) {
    if (error instanceof UnsupportedMimeTypeError) {
      bumpImageCounter('commit.rejected_mime', {
        purpose: input.purpose,
        detected: error.detectedMime ?? 'unknown',
      });
      // Best-effort clean up: get the bad upload off Cloudflare.
      try {
        await deleteImage(session.imageId);
      } catch (cleanupError) {
        logWarning('commit-image-asset: cleanup deleteImage failed', {
          imageId: session.imageId,
          error: (cleanupError as Error).message,
        });
      }
      throw new CommitImageAssetError(
        'UNSUPPORTED_MIME_TYPE',
        `unsupported image MIME type: ${error.detectedMime ?? 'unknown'}`,
        400,
      );
    }
    throw error;
  }

  await recordUpload(input.userId, input.quotaScope);

  const width = typeof (metadata as { width?: unknown }).width === 'number'
    ? Number((metadata as { width?: number }).width)
    : null;
  const height = typeof (metadata as { height?: unknown }).height === 'number'
    ? Number((metadata as { height?: number }).height)
    : null;

  const asset = makeImageAssetDoc({
    imageId: session.imageId,
    uploadedBy: input.userObjectId,
    width,
    height,
    mimeType,
    moderationStatus: isImageModerationPendingByDefault() ? 'pending' : 'auto-ok',
  });

  await enqueueBlurhashJob({
    imageId: session.imageId,
    target: input.blurhashTarget,
    enqueuedAt: Date.now(),
    requestId: input.requestId,
  });

  bumpImageCounter('commit.ok', {
    purpose: input.purpose,
    moderation: asset.moderationStatus,
  });
  logInfo('image asset committed', {
    imageId: session.imageId,
    purpose: input.purpose,
    moderation: asset.moderationStatus,
    width: asset.width,
    height: asset.height,
    requestId: input.requestId,
  });

  return { asset, session };
}
