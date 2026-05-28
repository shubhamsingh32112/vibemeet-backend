/**
 * Commits Cloudflare direct-upload sessions into support-ticket attachments.
 * Does not attach assets to user/creator profiles (no blurhash back-fill).
 */

import type { Types } from 'mongoose';
import {
  consumeSession,
  type UploadSession,
} from '../images/upload-session.service';
import {
  getImageMetadata,
  CloudflareImagesError,
  deleteImage,
} from '../images/cloudflare.client';
import { sniffImageMime, UnsupportedMimeTypeError } from '../images/mime-sniff.service';
import { recordUpload } from '../images/upload-quota.service';
import { buildGalleryUrls } from '../images/image-url';
import { logWarning } from '../../utils/logger';
import type { ISupportTicketAttachment } from './support.model';

const ALLOWED_SUPPORT_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export class SupportAttachmentCommitError extends Error {
  readonly status: number;
  constructor(message: string, status: number = 400) {
    super(message);
    this.status = status;
  }
}

export interface CommitSupportAttachmentInput {
  sessionId: string;
  userId: string;
  name?: string;
  isScreenshot?: boolean;
}

export interface CommitSupportAttachmentResult {
  attachment: ISupportTicketAttachment;
  session: UploadSession;
}

export async function commitSupportAttachment(
  input: CommitSupportAttachmentInput,
): Promise<CommitSupportAttachmentResult> {
  const session = await consumeSession(input.sessionId, input.userId, 'support-ticket');
  if (!session) {
    throw new SupportAttachmentCommitError(
      'Upload session not found, expired, or owned by another user',
    );
  }

  let metadata: Awaited<ReturnType<typeof getImageMetadata>>;
  try {
    metadata = await getImageMetadata(session.imageId);
  } catch (error) {
    if (error instanceof CloudflareImagesError && error.status === 404) {
      throw new SupportAttachmentCommitError(
        'Image upload not found — please pick the photo again and retry',
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
      try {
        await deleteImage(session.imageId);
      } catch (cleanupError) {
        logWarning('support-attachment-commit: cleanup deleteImage failed', {
          imageId: session.imageId,
          error: (cleanupError as Error).message,
        });
      }
      throw new SupportAttachmentCommitError('Unsupported image format. Use JPEG, PNG, or WebP.');
    }
    throw error;
  }

  if (!ALLOWED_SUPPORT_MIME_TYPES.has(mimeType)) {
    throw new SupportAttachmentCommitError('Unsupported image format. Use JPEG, PNG, or WebP.');
  }

  await recordUpload(input.userId, 'support');

  const urls = buildGalleryUrls(session.imageId);
  const safeName =
    typeof input.name === 'string' && input.name.trim().length > 0
      ? input.name.trim().slice(0, 120)
      : `attachment-${session.imageId.slice(0, 8)}`;

  const metaWidth = typeof (metadata as { width?: unknown }).width === 'number'
    ? Number((metadata as { width?: number }).width)
    : 0;
  const metaHeight = typeof (metadata as { height?: unknown }).height === 'number'
    ? Number((metadata as { height?: number }).height)
    : 0;
  const sizeHint = session.declaredSizeBytes ?? 0;
  const sizeBytes = sizeHint > 0 ? sizeHint : Math.max(1, metaWidth * metaHeight);

  const attachment: ISupportTicketAttachment = {
    name: safeName,
    mimeType,
    sizeBytes,
    isScreenshot: Boolean(input.isScreenshot),
    imageId: session.imageId,
    url: urls.md,
  };

  return { attachment, session };
}

export async function commitSupportAttachmentsFromSessions(params: {
  userId: string;
  userObjectId: Types.ObjectId;
  sessionIds: string[];
  sessionMeta?: Array<{ sessionId: string; name?: string; isScreenshot?: boolean }>;
}): Promise<ISupportTicketAttachment[]> {
  const { userId, sessionIds, sessionMeta } = params;
  if (sessionIds.length === 0) return [];

  const metaById = new Map(
    (sessionMeta || []).map((m) => [m.sessionId, m] as const),
  );

  const results: ISupportTicketAttachment[] = [];
  for (const sessionId of sessionIds) {
    const meta = metaById.get(sessionId);
    const { attachment } = await commitSupportAttachment({
      sessionId,
      userId,
      name: meta?.name,
      isScreenshot: meta?.isScreenshot,
    });
    results.push(attachment);
  }
  return results;
}
