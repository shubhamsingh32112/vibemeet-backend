import type { Request, Response } from 'express';
import { getPublicAppConfig } from './app-config.service';

export const getAppConfig = async (_req: Request, res: Response): Promise<void> => {
  res.json({
    success: true,
    data: getPublicAppConfig(),
  });
};
