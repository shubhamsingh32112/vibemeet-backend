import type { Request, Response } from 'express';

/**
 * Minimal compatibility wrapper to serve both legacy and normalized payloads.
 *
 * It optionally validates the normalized data using a provided validator
 * (Zod-like: must expose a parse() method). If no validator is passed,
 * the data is returned as-is.
 */
interface SendCompatibleResponseArgs<TLegacy, TNormalized> {
  req: Request;
  res: Response;
  legacyData: TLegacy;
  normalizedData: TNormalized;
  // Zod-like schema or any object with a parse() method
  validator?: { parse: (value: unknown) => unknown };
  deprecations?: string[];
}

export function sendCompatibleResponse<TLegacy, TNormalized>({
  res,
  legacyData,
  normalizedData,
  validator,
  deprecations,
}: SendCompatibleResponseArgs<TLegacy, TNormalized>): void {
  let safeNormalized = normalizedData as unknown;

  if (validator && typeof validator.parse === 'function') {
    try {
      safeNormalized = validator.parse(normalizedData);
    } catch {
      // If validation fails, fall back to unvalidated data
      safeNormalized = normalizedData;
    }
  }

  res.status(200).json({
    success: true,
    data: legacyData,
    normalized: safeNormalized,
    deprecations: deprecations ?? [],
  });
}

