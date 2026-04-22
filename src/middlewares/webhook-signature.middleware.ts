import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logError, logWarning, logInfo } from '../utils/logger';
import { recordPaymentMetric } from '../utils/monitoring';

function allowInsecureWebhookBypass(): boolean {
  return process.env.ALLOW_INSECURE_WEBHOOKS === 'true';
}

function getRawBodyBuffer(req: Request): Buffer {
  return Buffer.isBuffer(req.body)
    ? (req.body as Buffer)
    : Buffer.from(
        req.body === undefined || req.body === null ? '' : JSON.stringify(req.body),
        'utf8'
      );
}

function timingSafeHexEquals(aHex: string, bHex: string): boolean {
  try {
    const a = Buffer.from(aHex, 'utf8');
    const b = Buffer.from(bHex, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

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
      if (allowInsecureWebhookBypass()) {
        logWarning('Missing X-SIGNATURE header - allowing due to ALLOW_INSECURE_WEBHOOKS=true', {
          path: req.path,
        });
        return next();
      }
      logWarning('Missing X-SIGNATURE header - rejecting (set ALLOW_INSECURE_WEBHOOKS=true to bypass)', {
        path: req.path,
      });
      res.status(401).json({
        success: false,
        error: 'Missing webhook signature',
      });
      return;
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

    const rawBody = getRawBodyBuffer(req);

    if (!Buffer.isBuffer(req.body) && process.env.NODE_ENV === 'production') {
      logWarning('Webhook body was not raw Buffer in production — signature may be wrong', {
        path: req.path,
      });
    }

    const expectedSignature = crypto.createHmac('sha256', apiSecret).update(rawBody).digest('hex');

    const isValid = timingSafeHexEquals(String(signature), expectedSignature);

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

/**
 * Stream Chat webhook signature verification.
 * Uses Stream's X-SIGNATURE HMAC SHA256 over raw request body.
 */
export const verifyStreamChatWebhookSignature = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  try {
    const signature = req.headers['x-signature'] as string | undefined;
    const apiKey = req.headers['x-api-key'] as string | undefined;
    const apiSecret = process.env.STREAM_CHAT_API_SECRET || process.env.STREAM_API_SECRET;
    const expectedApiKey = process.env.STREAM_CHAT_API_KEY || process.env.STREAM_API_KEY;

    if (process.env.NODE_ENV === 'production' && !apiSecret) {
      res.status(503).json({
        success: false,
        error: 'Chat webhook verification not configured',
      });
      return;
    }

    if (!signature) {
      if (process.env.NODE_ENV !== 'production') {
        if (allowInsecureWebhookBypass()) {
          logWarning('Missing chat webhook signature allowed by ALLOW_INSECURE_WEBHOOKS=true', {
            path: req.path,
          });
          next();
          return;
        }
        logWarning('Missing chat webhook signature rejected (set ALLOW_INSECURE_WEBHOOKS=true to bypass)', {
          path: req.path,
        });
        res.status(401).json({ success: false, error: 'Missing webhook signature' });
        return;
      }
      res.status(401).json({ success: false, error: 'Missing webhook signature' });
      return;
    }

    if (!apiSecret) {
      res.status(500).json({ success: false, error: 'Chat webhook verification unavailable' });
      return;
    }

    const expectedSignature = crypto
      .createHmac('sha256', apiSecret)
      .update(getRawBodyBuffer(req))
      .digest('hex');

    if (!timingSafeHexEquals(String(signature), expectedSignature)) {
      res.status(401).json({ success: false, error: 'Invalid webhook signature' });
      return;
    }

    if (expectedApiKey && apiKey !== expectedApiKey) {
      res.status(401).json({ success: false, error: 'Invalid API key' });
      return;
    }

    next();
  } catch (error) {
    logError('Error verifying chat webhook signature', error, { path: req.path });
    res.status(500).json({ success: false, error: 'Webhook verification failed' });
  }
};

/**
 * Razorpay webhook signature verification.
 * Signature header: X-Razorpay-Signature = HMAC_SHA256(rawBody, RAZORPAY_WEBHOOK_SECRET)
 */
export const verifyRazorpayWebhookSignature = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  try {
    const signature = req.headers['x-razorpay-signature'] as string | undefined;
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!signature) {
      recordPaymentMetric('webhook.verify_failed', 1, { provider: 'razorpay', reason: 'missing_signature' });
      res.status(401).json({ success: false, error: 'Missing webhook signature' });
      return;
    }

    if (!webhookSecret) {
      recordPaymentMetric('webhook.verify_failed', 1, { provider: 'razorpay', reason: 'missing_secret' });
      res.status(503).json({
        success: false,
        error: 'Payment webhook verification not configured',
      });
      return;
    }

    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(getRawBodyBuffer(req))
      .digest('hex');

    if (!timingSafeHexEquals(String(signature), expectedSignature)) {
      recordPaymentMetric('webhook.verify_failed', 1, { provider: 'razorpay', reason: 'signature_mismatch' });
      res.status(401).json({ success: false, error: 'Invalid webhook signature' });
      return;
    }

    recordPaymentMetric('webhook.verify_success', 1, { provider: 'razorpay' });
    next();
  } catch (error) {
    recordPaymentMetric('webhook.verify_failed', 1, { provider: 'razorpay', reason: 'middleware_exception' });
    logError('Error verifying Razorpay webhook signature', error, { path: req.path });
    res.status(500).json({ success: false, error: 'Webhook verification failed' });
  }
};
