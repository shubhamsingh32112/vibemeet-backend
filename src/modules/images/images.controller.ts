/**
 * HTTP surface for the Cloudflare Images pipeline.
 *
 * Endpoints:
 *   POST /images/direct-upload  -> issue Cloudflare upload URL + session
 *   GET  /images/presets        -> list preset avatar imageIds + variant URLs
 *   GET  /images/health         -> feature flag + breaker state probe
 *
 * Commit endpoints are owned by the resource (creator/user) controllers
 * because they need to mutate the owning document atomically.
 */

import type { Request, Response } from 'express';
import { User } from '../user/user.model';
import {
  assertCloudflareEnabled,
  CloudflareImagesDisabledError,
  getCloudflareConfig,
} from '../../config/cloudflare';
import {
  createDirectUpload,
  CloudflareImagesCircuitOpenError,
  CloudflareImagesError,
} from './cloudflare.client';
import {
  createSession,
  type UploadPurpose,
} from './upload-session.service';
import {
  assertCanUpload,
  UploadQuotaExceededError,
  type QuotaScope,
} from './upload-quota.service';
import { getDefaultPresetImageId, listPresetImageIds } from './preset-image-ids';
import { buildAvatarUrls } from './image-url';
import { logError, logInfo } from '../../utils/logger';
import { bumpImageCounter } from './image-metrics';

const VALID_PURPOSES: UploadPurpose[] = [
  'creator-avatar',
  'creator-gallery',
  'user-avatar',
  'support-ticket',
  'story-image',
  'moment-photo',
  'moment-thumbnail',
];

const PURPOSE_QUOTA: Record<UploadPurpose, QuotaScope> = {
  'creator-avatar': 'avatar',
  'creator-gallery': 'gallery',
  'user-avatar': 'avatar',
  'admin-moderation': 'avatar',
  'support-ticket': 'support',
  'story-image': 'moments',
  'moment-photo': 'moments',
  'moment-thumbnail': 'moments',
};

const PURPOSE_MAX_BYTES: Partial<Record<UploadPurpose, number>> = {
  'story-image': 10 * 1024 * 1024,
  'moment-photo': 20 * 1024 * 1024,
  'moment-thumbnail': 5 * 1024 * 1024,
};

const MAX_DECLARED_SIZE_BYTES = 25 * 1024 * 1024;

/**
 * Signals the Flutter client that the image pipeline is degraded.
 * The client uses this to surface a non-blocking banner and to queue
 * pending uploads for auto-retry once the header drops.
 *
 * Exported so the creator/user controllers can call it on commit failures
 * that bubble up from a circuit-open or disabled state.
 */
export function setDegradedHeader(res: Response): void {
  res.setHeader('X-Image-Service-Degraded', '1');
}

/**
 * Short, client-safe copy for Cloudflare Images failures.
 * Raw upstream bodies often include URLs / JSON — never return those verbatim.
 */
export function safeCloudflareImagesClientError(status: number): string {
  if (status === 404) {
    return 'The image service could not find or prepare that upload. Please pick the photo again and retry.';
  }
  if (status === 429) {
    return 'Too many image uploads right now. Please wait a few minutes and try again.';
  }
  if (status >= 500) {
    return 'Our image service is temporarily unavailable. Please try again shortly.';
  }
  return 'The image service could not process this upload. Please try a different photo or try again later.';
}

function handleDisabled(res: Response, error: CloudflareImagesDisabledError): void {
  bumpImageCounter('endpoint.disabled');
  setDegradedHeader(res);
  res.status(503).json({
    success: false,
    code: 'IMAGES_DISABLED',
    error: error.message,
  });
}

function handleCloudflareError(res: Response, error: unknown): void {
  if (error instanceof CloudflareImagesCircuitOpenError) {
    bumpImageCounter('endpoint.circuit_open');
    setDegradedHeader(res);
    res.status(503).json({
      success: false,
      code: 'CLOUDFLARE_IMAGES_UNAVAILABLE',
      error: 'image service is temporarily unavailable; please retry',
    });
    return;
  }
  if (error instanceof CloudflareImagesError) {
    bumpImageCounter('endpoint.upstream_error', { status: error.status });
    logError('Cloudflare Images upstream error (redacted for client)', error);
    res.status(error.status >= 500 ? 502 : error.status).json({
      success: false,
      code: 'CLOUDFLARE_IMAGES_ERROR',
      error: safeCloudflareImagesClientError(error.status),
    });
    return;
  }
  logError('Images controller: unexpected error', error);
  res.status(500).json({
    success: false,
    error: 'internal_error',
  });
}

export async function createDirectUploadHandler(req: Request, res: Response): Promise<void> {
  try {
    assertCloudflareEnabled();
  } catch (error) {
    if (error instanceof CloudflareImagesDisabledError) {
      handleDisabled(res, error);
      return;
    }
    throw error;
  }

  const firebaseUid = req.auth?.firebaseUid;
  if (!firebaseUid) {
    res.status(401).json({ success: false, error: 'unauthenticated' });
    return;
  }

  const rawPurpose = String(req.body?.purpose || '').trim() as UploadPurpose;
  if (!VALID_PURPOSES.includes(rawPurpose)) {
    res.status(400).json({
      success: false,
      code: 'INVALID_PURPOSE',
      error: `purpose must be one of: ${VALID_PURPOSES.join(', ')}`,
    });
    return;
  }

  const declaredSize = Number(req.body?.declaredSizeBytes ?? 0);
  if (!Number.isFinite(declaredSize) || declaredSize <= 0) {
    res.status(400).json({
      success: false,
      code: 'INVALID_SIZE',
      error: 'declaredSizeBytes must be a positive integer',
    });
    return;
  }

  const { maxUploadBytes } = getCloudflareConfig();
  const purposeMax = PURPOSE_MAX_BYTES[rawPurpose];
  const hardCeiling = Math.min(
    MAX_DECLARED_SIZE_BYTES,
    maxUploadBytes,
    purposeMax ?? maxUploadBytes,
  );
  if (declaredSize > hardCeiling) {
    res.status(413).json({
      success: false,
      code: 'FILE_TOO_LARGE',
      error: `declaredSizeBytes exceeds ceiling of ${hardCeiling} bytes`,
    });
    return;
  }

  const user = await User.findOne({ firebaseUid }).select('_id role');
  if (!user) {
    res.status(404).json({ success: false, error: 'user_not_found' });
    return;
  }

  const userId = user._id.toString();
  const quotaScope = PURPOSE_QUOTA[rawPurpose];

  try {
    await assertCanUpload(userId, quotaScope);
  } catch (error) {
    if (error instanceof UploadQuotaExceededError) {
      bumpImageCounter('endpoint.quota_exceeded', { scope: error.scope });
      res.status(429).json({
        success: false,
        code: 'UPLOAD_QUOTA_EXCEEDED',
        error: `quota exceeded for ${error.scope}`,
        retryAfterSeconds: error.retryAfterSeconds,
      });
      return;
    }
    throw error;
  }

  try {
    const cloudflare = await createDirectUpload({
      requireSignedURLs: false,
      metadata: {
        purpose: rawPurpose,
        uploadedBy: userId,
        firebaseUid,
      },
    });

    const session = await createSession({
      userId,
      purpose: rawPurpose,
      imageId: cloudflare.imageId,
      declaredSizeBytes: declaredSize,
    });

    bumpImageCounter('endpoint.direct_upload_ok', { purpose: rawPurpose });
    logInfo('images.direct-upload issued', {
      userId,
      purpose: rawPurpose,
      imageId: cloudflare.imageId,
      sessionId: session.sessionId,
      declaredSize,
    });

    res.status(201).json({
      success: true,
      data: {
        uploadURL: cloudflare.uploadURL,
        uploadUrl: cloudflare.uploadURL,
        imageId: cloudflare.imageId,
        sessionId: session.sessionId,
        expiresAt: new Date(session.expiresAt).toISOString(),
        maxUploadBytes,
      },
    });
  } catch (error) {
    handleCloudflareError(res, error);
  }
}

export async function getPresetAvatarsHandler(_req: Request, res: Response): Promise<void> {
  try {
    assertCloudflareEnabled();
  } catch (error) {
    if (error instanceof CloudflareImagesDisabledError) {
      handleDisabled(res, error);
      return;
    }
    throw error;
  }

  const male = listPresetImageIds('male').map((entry) => ({
    fileName: entry.fileName,
    imageId: entry.imageId,
    avatarUrls: buildAvatarUrls(entry.imageId),
  }));
  const female = listPresetImageIds('female').map((entry) => ({
    fileName: entry.fileName,
    imageId: entry.imageId,
    avatarUrls: buildAvatarUrls(entry.imageId),
  }));
  const defaultImageId = getDefaultPresetImageId();
  res.status(200).json({
    success: true,
    data: {
      male,
      female,
      default: defaultImageId
        ? {
            imageId: defaultImageId,
            avatarUrls: buildAvatarUrls(defaultImageId),
          }
        : null,
    },
  });
}

export async function getImagesHealthHandler(_req: Request, res: Response): Promise<void> {
  const enabled = (() => {
    try {
      assertCloudflareEnabled();
      return true;
    } catch {
      return false;
    }
  })();
  res.status(enabled ? 200 : 503).json({
    success: enabled,
    enabled,
    timestamp: new Date().toISOString(),
  });
}
