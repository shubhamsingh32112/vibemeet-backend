import type { Request, Response } from 'express';
import { User } from '../user/user.model';
import {
  assertMomentsEnabled,
  getMomentsConfig,
  respondMomentsDisabled,
} from '../../config/moments';
import {
  assertCloudflareStreamEnabled,
  CloudflareStreamDisabledError,
} from '../../config/cloudflare-stream';
import { createStreamDirectUpload, getStreamVideoDetails, CloudflareStreamCircuitOpenError } from './cloudflare-stream.client';
import {
  createStreamUploadSession,
  getStreamUploadSession,
} from './stream-upload-session.service';
import { verifyStreamWebhook } from './stream.webhook';
import {
  findStreamSessionByVideoId,
  updateStreamUploadSession,
} from './stream-upload-session.service';
import type { ContentClass } from '../media-shared/types';
import { logError, logInfo } from '../../utils/logger';
import { emitMediaReady } from '../moments/moments.gateway';

async function resolveUser(req: Request) {
  if (!req.auth?.firebaseUid) return null;
  return User.findOne({ firebaseUid: req.auth.firebaseUid });
}

function maxDurationForClass(contentClass: ContentClass): number {
  const cfg = getMomentsConfig();
  return contentClass === 'story' ? cfg.storyVideoMaxSeconds : cfg.reelVideoMaxSeconds;
}

export async function createDirectUploadHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    assertCloudflareStreamEnabled();
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    if (user.role !== 'creator' && user.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Creators only' });
      return;
    }

    const contentClass = req.body?.contentClass as ContentClass;
    if (contentClass !== 'story' && contentClass !== 'moment') {
      res.status(400).json({ success: false, error: 'contentClass must be story or moment' });
      return;
    }

    const cf = await createStreamDirectUpload({
      contentClass,
      maxDurationSeconds: maxDurationForClass(contentClass),
    });

    const session = await createStreamUploadSession({
      userId: user._id.toString(),
      firebaseUid: user.firebaseUid,
      contentClass,
      streamVideoId: cf.uid,
    });

    res.json({
      success: true,
      data: {
        uploadURL: cf.uploadURL,
        sessionId: session.sessionId,
        processingStatus: session.processingStatus,
      },
    });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    if (error instanceof CloudflareStreamDisabledError) {
      res.status(503).json({ success: false, error: error.message, code: 'CLOUDFLARE_STREAM_DISABLED' });
      return;
    }
    if (error instanceof CloudflareStreamCircuitOpenError) {
      res.status(503).json({
        success: false,
        error: error.message,
        code: 'CLOUDFLARE_STREAM_UNAVAILABLE',
      });
      return;
    }
    logError('Stream direct upload failed', error);
    res.status(500).json({ success: false, error: 'Failed to create upload URL' });
  }
}

export async function getUploadStatusHandler(req: Request, res: Response): Promise<void> {
  try {
    assertMomentsEnabled();
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const session = await getStreamUploadSession(req.params.sessionId);
    if (!session || session.userId !== user._id.toString()) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }
    res.json({
      success: true,
      data: {
        sessionId: session.sessionId,
        processingStatus: session.processingStatus,
        contentClass: session.contentClass,
      },
    });
  } catch (error) {
    if (respondMomentsDisabled(error, res)) return;
    logError('Stream upload status failed', error);
    res.status(500).json({ success: false, error: 'Failed to get upload status' });
  }
}

export async function handleStreamWebhook(req: Request, res: Response): Promise<void> {
  try {
    if (!verifyStreamWebhook(req)) {
      res.status(401).json({ success: false, error: 'Invalid webhook signature' });
      return;
    }

    const payload = req.body as {
      uid?: string;
      status?: { state?: string };
      duration?: number;
    };
    const uid = payload.uid;
    if (!uid) {
      res.sendStatus(200);
      return;
    }

    const session = await findStreamSessionByVideoId(uid);
    if (!session) {
      logInfo('Stream webhook for unknown session', { uid });
      res.sendStatus(200);
      return;
    }

    const state = payload.status?.state;
    if (state === 'inprogress' || state === 'queued') {
      session.processingStatus = 'processing';
    } else if (state === 'ready') {
      session.processingStatus = 'ready';
      try {
        const details = await getStreamVideoDetails(uid);
        session.durationSeconds = details.duration;
      } catch {
        // non-fatal
      }
    } else if (state === 'error') {
      session.processingStatus = 'failed';
    }

    await updateStreamUploadSession(session);
    if (session.processingStatus === 'ready' && session.firebaseUid) {
      emitMediaReady(session.firebaseUid, session.sessionId);
    }
    res.sendStatus(200);
  } catch (error) {
    logError('Stream webhook handler failed', error);
    res.status(500).json({ success: false, error: 'Webhook processing failed' });
  }
}

export async function getStreamHealthHandler(_req: Request, res: Response): Promise<void> {
  res.json({
    success: true,
    data: {
      enabled: process.env.USE_CLOUDFLARE_STREAM === 'true',
      configured: Boolean(process.env.CLOUDFLARE_STREAM_API_TOKEN),
    },
  });
}
