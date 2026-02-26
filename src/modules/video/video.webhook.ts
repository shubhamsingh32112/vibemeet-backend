import type { Request, Response } from 'express';
import { videoWebhookApplicationService } from './video-webhook.application.service';

export const handleStreamVideoWebhook = async (req: Request, res: Response): Promise<void> =>
  videoWebhookApplicationService.handleStreamVideoWebhook(req, res);

export const processCallBilling = async (call: unknown): Promise<void> =>
  videoWebhookApplicationService.processCallBilling(call);

export const clearAllCreatorBusyStates = async (): Promise<void> =>
  videoWebhookApplicationService.clearAllCreatorBusyStates();

