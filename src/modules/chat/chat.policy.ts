/**
 * Chat Policy — Centralised rules for chat behaviour.
 *
 * Pricing:
 *   - Users get FREE_MESSAGES_PER_CREATOR free messages per creator per task day, then 5 coins per message.
 *   - Creators always chat for free.
 *
 * Content rules:
 *   - Text: any text allowed for all roles.
 *   - Images/videos: creators & admins only.
 *   - Voice: all roles.
 */

import { FREE_MESSAGES_PER_CREATOR as FREE_MESSAGES_PER_CREATOR_MODEL, COST_PER_MESSAGE } from './chat-message-quota.model';

export const FREE_MESSAGES_PER_CREATOR = FREE_MESSAGES_PER_CREATOR_MODEL;
export const COST_PER_MESSAGE_COINS = COST_PER_MESSAGE;

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
