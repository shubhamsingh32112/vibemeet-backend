import type { Request, Response } from 'express';
import { getStreamClient } from '../../config/stream';
import { User } from '../user/user.model';

/**
 * Stream Chat webhook handler for message validation
 * 
 * This is the AUTHORITATIVE layer that enforces chat rules server-side.
 * Frontend validation is for UX only - this prevents bypasses.
 * 
 * Webhook endpoint: POST /api/v1/chat/webhook
 * 
 * Stream will call this on message.new events.
 * Return 200 to allow, 403 to reject.
 */

interface StreamWebhookPayload {
  type: string;
  message?: {
    id: string;
    text?: string;
    user?: {
      id: string;
      extraData?: {
        appRole?: string;
      };
    };
    attachments?: Array<{
      type: string;
      [key: string]: unknown;
    }>;
  };
  channel?: {
    id: string;
    type: string;
  };
}

/**
 * Validate text message (only digits 0-5 allowed)
 */
const validateTextMessage = (text: string | undefined): boolean => {
  if (!text) return true; // Empty messages are allowed
  
  // Only digits 0-5 and spaces allowed
  const ALLOWED_TEXT_REGEX = /^[0-5\s]*$/;
  return ALLOWED_TEXT_REGEX.test(text);
};

/**
 * Validate attachments (only creators can send)
 */
const validateAttachments = async (
  attachments: Array<{ type: string; [key: string]: unknown }> | undefined,
  userId: string
): Promise<boolean> => {
  if (!attachments || attachments.length === 0) return true; // No attachments is fine
  
  // Voice messages are allowed for all users (they're attachments but bypass text rules)
  const hasOnlyVoice = attachments.every(att => att.type === 'audio' || att.type === 'voice');
  if (hasOnlyVoice) return true; // Voice messages are always allowed
  
  // For other attachments (images, videos), check user role
  try {
    // Get user from database to check role
    const user = await User.findOne({ firebaseUid: userId });
    if (!user) {
      console.error(`❌ [WEBHOOK] User not found: ${userId}`);
      return false;
    }
    
    // Only creators and admins can send media attachments
    if (user.role !== 'creator' && user.role !== 'admin') {
      console.log(`❌ [WEBHOOK] User ${userId} (role: ${user.role}) attempted to send media attachments`);
      return false;
    }
    
    return true;
  } catch (error) {
    console.error(`❌ [WEBHOOK] Error validating attachments:`, error);
    return false;
  }
};

/**
 * Stream webhook handler
 * 
 * Stream sends webhook events for various actions.
 * We handle message.new to validate messages before they're sent.
 */
export const handleStreamWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = req.body as StreamWebhookPayload;
    
    console.log(`📥 [WEBHOOK] Received webhook: ${payload.type}`);
    
    // Handle message.new events (message validation)
    if (payload.type === 'message.new' && payload.message) {
      const message = payload.message;
      const userId = message.user?.id;
      
      if (!userId) {
        console.error('❌ [WEBHOOK] Message missing user ID');
        res.status(400).json({ error: 'Missing user ID' });
        return;
      }
      
      // Validate text message
      if (message.text && !validateTextMessage(message.text)) {
        console.log(`❌ [WEBHOOK] Message rejected: Invalid text pattern`);
        console.log(`   Text: "${message.text}"`);
        console.log(`   User: ${userId}`);
        res.status(403).json({ 
          error: 'Message violates chat rules: Only numbers 0 to 5 are allowed',
        });
        return;
      }
      
      // Validate attachments
      const attachmentsValid = await validateAttachments(message.attachments, userId);
      if (!attachmentsValid) {
        console.log(`❌ [WEBHOOK] Message rejected: Attachments not allowed for user`);
        console.log(`   User: ${userId}`);
        res.status(403).json({ 
          error: 'Attachments not allowed for users. Only creators can send media.',
        });
        return;
      }
      
      // Message is valid
      console.log(`✅ [WEBHOOK] Message validated successfully`);
      res.status(200).json({ success: true });
      return;
    }
    
    // For other webhook types, just acknowledge
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ [WEBHOOK] Error processing webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Verify webhook signature (optional but recommended)
 * Stream can send a signature header to verify authenticity
 */
export const verifyWebhookSignature = (req: Request): boolean => {
  // TODO: Implement signature verification if Stream provides it
  // For now, we'll rely on network security (HTTPS, IP whitelist, etc.)
  return true;
};
