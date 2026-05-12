import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

declare module 'express-serve-static-core' {
  interface Request {
    /** Server-generated or propagated request correlation */
    requestId?: string;
    /** Optional client/proxy correlation (X-Correlation-Id) */
    correlationId?: string;
  }
}

function headerString(req: Request, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (Array.isArray(v) && v[0]) return String(v[0]).trim();
  return undefined;
}

/**
 * Adds requestId (propagate X-Request-Id or generate) and optional correlationId.
 * Sets X-Request-Id on the response for clients.
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  req.requestId = headerString(req, 'x-request-id') ?? randomUUID();
  req.correlationId =
    headerString(req, 'x-correlation-id') ?? headerString(req, 'x-correlationid') ?? undefined;
  res.setHeader('X-Request-Id', req.requestId);
  next();
}
