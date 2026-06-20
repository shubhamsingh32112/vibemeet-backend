/**
 * Keeps Redis stream upload sessions in sync with Cloudflare Stream state.
 *
 * Webhooks are the fast path, but upload-status polling must also query
 * Cloudflare directly so clients are not stuck when webhooks are missing
 * or delayed.
 */

import { getStreamVideoDetails } from './cloudflare-stream.client';
import {
  updateStreamUploadSession,
  type StreamUploadSession,
} from './stream-upload-session.service';
import type { ProcessingStatus } from '../media-shared/types';
import { logInfo, logWarning } from '../../utils/logger';
import { emitMediaReady } from '../moments/moments.gateway';

function mapCloudflareStreamState(state: string | undefined): ProcessingStatus | null {
  if (!state) return null;
  if (state === 'ready') return 'ready';
  if (state === 'error') return 'failed';
  if (state === 'inprogress' || state === 'queued' || state === 'pendingupload') {
    return 'processing';
  }
  if (state === 'downloading') return 'processing';
  return null;
}

export async function applyStreamVideoStateToSession(
  session: StreamUploadSession,
  state: string | undefined,
  durationSeconds?: number,
): Promise<{ session: StreamUploadSession; becameReady: boolean }> {
  const mapped = mapCloudflareStreamState(state);
  if (!mapped) {
    return { session, becameReady: false };
  }

  const previous = session.processingStatus;
  session.processingStatus = mapped;
  if (mapped === 'ready') {
    if (durationSeconds != null) {
      session.durationSeconds = durationSeconds;
    } else if (session.durationSeconds == null) {
      try {
        const details = await getStreamVideoDetails(session.streamVideoId);
        if (details.duration != null) {
          session.durationSeconds = details.duration;
        }
      } catch {
        // non-fatal
      }
    }
  }

  return { session, becameReady: previous !== 'ready' && mapped === 'ready' };
}

export async function syncStreamUploadSessionFromCloudflare(
  session: StreamUploadSession,
): Promise<StreamUploadSession> {
  if (session.processingStatus === 'ready' || session.processingStatus === 'failed') {
    return session;
  }

  try {
    const details = await getStreamVideoDetails(session.streamVideoId);
    const { session: updated, becameReady } = await applyStreamVideoStateToSession(
      session,
      details.status?.state,
      details.duration,
    );

    if (updated.processingStatus !== session.processingStatus || becameReady) {
      await updateStreamUploadSession(updated);
      if (becameReady) {
        logInfo('Stream upload session synced to ready via poll', {
          sessionId: updated.sessionId,
          streamVideoId: updated.streamVideoId,
        });
      }
    }

    if (becameReady && updated.firebaseUid) {
      emitMediaReady(updated.firebaseUid, updated.sessionId);
    }

    return updated;
  } catch (error) {
    logWarning('Stream upload session sync failed', {
      sessionId: session.sessionId,
      streamVideoId: session.streamVideoId,
      error: (error as Error).message,
    });
    return session;
  }
}
