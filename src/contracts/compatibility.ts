import type { Request, Response } from 'express';
import type { ZodType } from 'zod';
import { featureFlags } from '../config/feature-flags';
import { logger } from '../utils/logger';

interface CompatibleResponseOptions<TLegacy, TNormalized> {
  req: Request;
  res: Response;
  legacyData: TLegacy;
  normalizedData: TNormalized;
  validator: ZodType<TNormalized>;
  deprecations: string[];
  statusCode?: number;
}

const shouldIncludeNormalizedPayload = (req: Request): boolean => {
  if (featureFlags.normalizedResponseAdapter) return true;
  const requestedShape = (req.header('x-api-response-shape') || '').trim().toLowerCase();
  return requestedShape === 'normalized' || requestedShape === 'dual';
};

export const sendCompatibleResponse = <TLegacy, TNormalized>({
  req,
  res,
  legacyData,
  normalizedData,
  validator,
  deprecations,
  statusCode = 200,
}: CompatibleResponseOptions<TLegacy, TNormalized>): void => {
  const shouldIncludeNormalized = shouldIncludeNormalizedPayload(req);
  const body: Record<string, unknown> = {
    success: true,
    data: legacyData,
  };

  if (shouldIncludeNormalized) {
    const parsed = validator.safeParse(normalizedData);
    if (parsed.success) {
      body.normalized = parsed.data;
      body.meta = {
        contractVersion: '2026-02',
        mode: 'v1-compatible+normalized',
        deprecations,
      };
      res.setHeader('x-api-contract-version', '2026-02');
      res.setHeader('x-api-response-mode', 'dual');
      res.status(statusCode).json(body);
      return;
    }

    logger.error('contracts.response_validation.failed', {
      path: req.path,
      errors: parsed.error.issues,
    });
    body.meta = {
      contractVersion: '2026-02',
      mode: 'v1-compatible',
      validation: 'failed',
      deprecations,
    };
    res.setHeader('x-api-contract-version', '2026-02');
    res.setHeader('x-api-response-mode', 'legacy');
    res.setHeader('x-api-contract-validation', 'failed');
    res.status(statusCode).json(body);
    return;
  }

  res.status(statusCode).json(body);
};

