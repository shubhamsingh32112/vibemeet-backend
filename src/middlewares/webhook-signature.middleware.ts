import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logError, logWarning, logInfo } from '../utils/logger';

/**
 * Middleware to verify Stream Video webhook signatures
 * 
 * Stream sends webhooks with X-SIGNATURE header containing HMAC-SHA256 signature
 * of the request body using the API secret.
 * 
 * Format: X-SIGNATURE = HMAC-SHA256(rawBody, STREAM_VIDEO_API_SECRET)
 */
export const verifyStreamWebhookSignature = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  try {
    // Get signature from header
    const signature = req.headers['x-signature'] as string;
    const apiKey = req.headers['x-api-key'] as string;
    
    // 🔥 DEVELOPMENT MODE: Allow webhooks without signature in dev (for testing)
    // In production, signature is required
    if (!signature && process.env.NODE_ENV === 'production') {
      logError('Missing X-SIGNATURE header', new Error('Missing webhook signature'), { path: req.path });
      res.status(401).json({ 
        success: false,
        error: 'Missing webhook signature' 
      });
      return;
    }
    
    if (!signature && process.env.NODE_ENV !== 'production') {
      logWarning('Missing X-SIGNATURE header - allowing in development mode', { path: req.path });
      return next();
    }

    // Get API secret from environment
    const apiSecret = process.env.STREAM_VIDEO_API_SECRET;
    if (!apiSecret) {
      logError('STREAM_VIDEO_API_SECRET not configured', new Error('Missing API secret'), { path: req.path });
      res.status(500).json({ 
        success: false,
        error: 'Webhook verification not configured' 
      });
      return;
    }

    // Get raw body for signature verification
    // Note: For production, consider using express.raw() for webhook routes
    // to capture the exact bytes Stream sends. For now, we stringify the parsed body.
    // This works because Stream sends JSON, and JSON.stringify produces consistent output.
    const rawBody = JSON.stringify(req.body);
    
    // Calculate expected signature
    const expectedSignature = crypto
      .createHmac('sha256', apiSecret)
      .update(rawBody)
      .digest('hex');

    // Compare signatures (constant-time comparison to prevent timing attacks)
    const isValid = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );

    if (!isValid) {
      logError('Invalid webhook signature', new Error('Signature mismatch'), {
        path: req.path,
        receivedPrefix: signature.substring(0, 20),
        expectedPrefix: expectedSignature.substring(0, 20),
      });
      res.status(401).json({ 
        success: false,
        error: 'Invalid webhook signature' 
      });
      return;
    }

    // Verify API key matches (additional security check)
    const expectedApiKey = process.env.STREAM_API_KEY;
    if (expectedApiKey && apiKey !== expectedApiKey) {
      logError('API key mismatch', new Error('API key mismatch'), { path: req.path });
      res.status(401).json({ 
        success: false,
        error: 'Invalid API key' 
      });
      return;
    }

    logInfo('Webhook signature verified', { path: req.path });
    next();
  } catch (error) {
    logError('Error verifying webhook signature', error, { path: req.path });
    res.status(500).json({ 
      success: false,
      error: 'Webhook verification failed' 
    });
  }
};
