/**
 * Chat Policy - Centralized rules for chat behavior
 * 
 * This is the single source of truth for chat rules.
 * Backend assigns policy → Stream user/channel metadata
 * Frontend reads policy → configures UI
 */

export interface ChatPolicy {
  allowText: boolean;
  allowImages: boolean;
  allowVideos: boolean;
  allowVoice: boolean;
  allowedTextPattern?: RegExp;
}

/**
 * Default chat policy
 * - Text: Only digits 0-5 allowed
 * - Images: Only creators
 * - Videos: Only creators
 * - Voice: All users
 */
export const DEFAULT_CHAT_POLICY: ChatPolicy = {
  allowText: true,
  allowImages: false, // Only creators can send images
  allowVideos: false, // Only creators can send videos
  allowVoice: true, // All users can send voice messages
  allowedTextPattern: /^[0-5\s]*$/, // Only digits 0-5 and spaces
};

/**
 * Get chat policy for a user role
 */
export const getChatPolicyForRole = (role: 'user' | 'creator' | 'admin'): ChatPolicy => {
  const policy = { ...DEFAULT_CHAT_POLICY };
  
  // Creators and admins can send media
  if (role === 'creator' || role === 'admin') {
    policy.allowImages = true;
    policy.allowVideos = true;
  }
  
  return policy;
};
