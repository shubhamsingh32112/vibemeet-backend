import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logError, logWarning, logInfo } from '../utils/logger';

/**
 * Middleware to verify Stream Video webhook signatures
 *
 * Stream sends webhooks with X-SIGNATURE header containing HMAC-SHA256 (hex)
 * of the **raw** request body using the API secret.
 *
 * The POST /api/v1/video/webhook route uses `express.raw()` in server.ts so
 * `req.body` is a Buffer of exact bytes Stream signed.
 */
export const verifyStreamWebhookSignature = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  try {
    const signature = req.headers['x-signature'] as string | undefined;
    const apiKey = req.headers['x-api-key'] as string | undefined;

    if (process.env.NODE_ENV === 'production' && !process.env.STREAM_VIDEO_API_SECRET) {
      logError(
        'STREAM_VIDEO_API_SECRET missing in production',
        new Error('Webhook verification not configured'),
        { path: req.path }
      );
      res.status(503).json({
        success: false,
        error: 'Webhook verification not configured',
      });
      return;
    }

    if (!signature && process.env.NODE_ENV === 'production') {
      logError('Missing X-SIGNATURE header', new Error('Missing webhook signature'), { path: req.path });
      res.status(401).json({
        success: false,
        error: 'Missing webhook signature',
      });
      return;
    }

    if (!signature && process.env.NODE_ENV !== 'production') {
      logWarning('Missing X-SIGNATURE header - allowing in development mode', { path: req.path });
      return next();
    }

    const apiSecret = process.env.STREAM_VIDEO_API_SECRET;
    if (!apiSecret) {
      logError('STREAM_VIDEO_API_SECRET not configured', new Error('Missing API secret'), { path: req.path });
      res.status(500).json({
        success: false,
        error: 'Webhook verification not configured',
      });
      return;
    }

    const rawBody = Buffer.isBuffer(req.body)
      ? (req.body as Buffer)
      : Buffer.from(
          req.body === undefined || req.body === null ? '' : JSON.stringify(req.body),
          'utf8'
        );

    if (!Buffer.isBuffer(req.body) && process.env.NODE_ENV === 'production') {
      logWarning('Webhook body was not raw Buffer in production — signature may be wrong', {
        path: req.path,
      });
    }

    const expectedSignature = crypto.createHmac('sha256', apiSecret).update(rawBody).digest('hex');

    let isValid = false;
    try {
      const a = Buffer.from(String(signature), 'utf8');
      const b = Buffer.from(expectedSignature, 'utf8');
      if (a.length === b.length) {
        isValid = crypto.timingSafeEqual(a, b);
      }
    } catch {
      isValid = false;
    }

    if (!isValid) {
      logError('Invalid webhook signature', new Error('Signature mismatch'), {
        path: req.path,
        receivedPrefix: String(signature).substring(0, 20),
        expectedPrefix: expectedSignature.substring(0, 20),
      });
      res.status(401).json({
        success: false,
        error: 'Invalid webhook signature',
      });
      return;
    }

    const expectedApiKey = process.env.STREAM_API_KEY;
    if (expectedApiKey && apiKey !== expectedApiKey) {
      logError('API key mismatch', new Error('API key mismatch'), { path: req.path });
      res.status(401).json({
        success: false,
        error: 'Invalid API key',
      });
      return;
    }

    logInfo('Webhook signature verified', { path: req.path });
    next();
  } catch (error) {
    logError('Error verifying webhook signature', error, { path: req.path });
    res.status(500).json({
      success: false,
      error: 'Webhook verification failed',
    });
  }
};
