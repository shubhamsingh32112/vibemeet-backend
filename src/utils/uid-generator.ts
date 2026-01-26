import { createHash } from 'crypto';

/**
 * Generate a deterministic UID from userId
 * Uses hash(userId) % 2^32 to fit in 32-bit signed integer
 * 
 * This enables:
 * - Call analytics
 * - Moderation
 * - Reconnection
 * - Recording mapping
 */
export function generateUidFromUserId(userId: string): number {
  // Create hash of userId
  const hash = createHash('sha256').update(userId).digest();
  
  // Take first 4 bytes and convert to 32-bit signed integer
  const uid = hash.readUInt32BE(0);
  
  // Ensure it's positive (Agora UIDs are unsigned, but we use signed for compatibility)
  // Modulo 2^31 to fit in signed 32-bit range
  return uid % 0x7FFFFFFF;
}
