import type { Request, Response } from 'express';
import { featureFlags } from '../../config/feature-flags';
import { VideoRepository } from './video.repository';
import * as legacy from './video.legacy.webhook';

const HANDLED_VIDEO_WEBHOOK_TYPES = new Set([
  'call.ended',
  'call.session_started',
  'call.session_ended',
  'call.ringing',
  'call.created',
  'call.accepted',
]);

export class VideoWebhookApplicationService {
  constructor(private readonly videoRepository: VideoRepository = new VideoRepository()) {}

  async handleStreamVideoWebhook(req: Request, res: Response): Promise<void> {
    if (!featureFlags.videoWebhookServiceCutover) {
      return legacy.handleStreamVideoWebhook(req, res);
    }

    const callId = this.extractCallId(req.body);
    if (callId) {
      await this.videoRepository.findCallByCallId(callId);
    }

    return legacy.handleStreamVideoWebhook(req, res);
  }

  async processCallBilling(call: unknown): Promise<void> {
    return legacy.processCallBilling(call);
  }

  async clearAllCreatorBusyStates(): Promise<void> {
    return legacy.clearAllCreatorBusyStates();
  }

  isSupportedWebhookType(type: string): boolean {
    return HANDLED_VIDEO_WEBHOOK_TYPES.has(type);
  }

  private extractCallId(payload: any): string | null {
    if (payload?.call?.id && typeof payload.call.id === 'string') {
      return payload.call.id;
    }
    if (typeof payload?.call_cid === 'string') {
      const segments = payload.call_cid.split(':');
      return segments.length > 1 ? segments[1] : null;
    }
    return null;
  }
}

export const videoWebhookApplicationService = new VideoWebhookApplicationService();

