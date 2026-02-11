/**
 * Chat Policy — Centralised rules for chat behaviour.
 *
 * Pricing:
 *   - Users get 3 free messages per creator, then 5 coins per message.
 *   - Creators always chat for free.
 *
 * Content rules:
 *   - Text: any text allowed for all roles.
 *   - Images/videos: creators & admins only.
 *   - Voice: all roles.
 */

export const FREE_MESSAGES_PER_CREATOR = 3;
export const COST_PER_MESSAGE_COINS = 5;

export interface ChatPolicy {
  allowText: boolean;
  allowImages: boolean;
  allowVideos: boolean;
  allowVoice: boolean;
}

export const DEFAULT_CHAT_POLICY: ChatPolicy = {
  allowText: true,
  allowImages: false, // Only creators
  allowVideos: false, // Only creators
  allowVoice: true,   // All roles
};

export const getChatPolicyForRole = (
  role: 'user' | 'creator' | 'admin',
): ChatPolicy => {
  const policy = { ...DEFAULT_CHAT_POLICY };
  if (role === 'creator' || role === 'admin') {
    policy.allowImages = true;
    policy.allowVideos = true;
  }
  return policy;
};
