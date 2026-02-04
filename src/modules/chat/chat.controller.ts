import type { Request } from 'express';
import { Response } from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { getStreamClient, ensureStreamUser } from '../../config/stream';
import { User } from '../user/user.model';
import { getChatPolicyForRole } from './chat.policy';

/**
 * Generate deterministic channel ID for User-Creator pair
 * 
 * IMPORTANT: Stream Chat channel IDs have a max length of 64 characters.
 * Firebase UIDs are ~28 chars each, so concatenating them would exceed the limit.
 * 
 * Solution: Hash the sorted UID pair to create a short, deterministic ID.
 * - Deterministic: Same UIDs always produce same hash
 * - Order-independent: Sorting ensures consistency
 * - Short: ~35 chars total (well under 64 limit)
 * - Collision-safe: SHA256 provides sufficient uniqueness
 * 
 * Format: uc_<32-char-hex-hash>
 */
const generateChannelId = (uid1: string, uid2: string): string => {
  // Sort to ensure determinism (same pair = same ID regardless of order)
  const [a, b] = [uid1, uid2].sort();
  
  // Create SHA256 hash of the sorted pair
  const hash = crypto
    .createHash('sha256')
    .update(`${a}:${b}`)
    .digest('hex')
    .slice(0, 32); // 32 chars is plenty for uniqueness
  
  // Prefix with short identifier (uc = userCreator)
  // Total length: 3 (prefix) + 32 (hash) = 35 chars (well under 64 limit)
  return `uc_${hash}`;
};

/**
 * POST /api/v1/chat/token
 * Get Stream Chat token for authenticated user
 */
export const getChatToken = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    const firebaseUid = req.auth.firebaseUid;
    const client = getStreamClient();

    // Get user from database to ensure they exist
    const user = await User.findOne({ firebaseUid });
    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    // Ensure Stream user exists (idempotent)
    // Do NOT pass role - Stream roles are separate from app roles
    // Store app role in extraData for business logic
    // Prioritize username over email/phone - check for both null and empty string
    const displayName = (user.username && user.username.trim().length > 0) 
      ? user.username 
      : (user.email && user.email.trim().length > 0)
        ? user.email
        : (user.phone && user.phone.trim().length > 0)
          ? user.phone
          : 'User';
    
    await ensureStreamUser(firebaseUid, {
      name: displayName,
      image: user.avatar,
      appRole: user.role, // Store app role in Stream user metadata
      username: user.username, // Store username as single source of truth
    });

    // Generate token
    const token = client.createToken(firebaseUid);

    res.json({
      success: true,
      data: {
        token,
      },
    });
  } catch (error) {
    console.error('❌ [CHAT] Error generating token:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate chat token',
    });
  }
};

/**
 * POST /api/v1/chat/channel
 * Create or fetch channel for User-Creator pair
 * 
 * Rule: Chat allowed only if at least one completed call exists
 * 
 * Input: { "otherUserId": "mongodb_object_id_string" }
 */
export const createOrGetChannel = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
      return;
    }

    const { otherUserId } = req.body;

    if (!otherUserId) {
      res.status(400).json({
        success: false,
        error: 'otherUserId is required',
      });
      return;
    }

    // Get current user
    const currentUser = await User.findOne({ firebaseUid: req.auth.firebaseUid });
    if (!currentUser) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    // Get other user (can be MongoDB ObjectId string or Firebase UID)
    let otherUser = await User.findById(otherUserId);
    if (!otherUser) {
      // Try finding by Firebase UID if ObjectId lookup failed
      otherUser = await User.findOne({ firebaseUid: otherUserId });
    }
    
    if (!otherUser) {
      res.status(404).json({
        success: false,
        error: 'Other user not found',
      });
      return;
    }

    // Use Firebase UIDs as Stream user IDs (consistent with token generation)
    const currentUserFirebaseUid = currentUser.firebaseUid;
    const otherUserFirebaseUid = otherUser.firebaseUid;

    // Ensure both users exist in Stream
    // Do NOT pass role - Stream roles are separate from app roles
    // Store app role in extraData for business logic
    // Prioritize username over email/phone - check for both null and empty string
    const currentUserDisplayName = (currentUser.username && currentUser.username.trim().length > 0)
      ? currentUser.username
      : (currentUser.email && currentUser.email.trim().length > 0)
        ? currentUser.email
        : (currentUser.phone && currentUser.phone.trim().length > 0)
          ? currentUser.phone
          : 'User';
    
    const otherUserDisplayName = (otherUser.username && otherUser.username.trim().length > 0)
      ? otherUser.username
      : (otherUser.email && otherUser.email.trim().length > 0)
        ? otherUser.email
        : (otherUser.phone && otherUser.phone.trim().length > 0)
          ? otherUser.phone
          : 'User';
    
    await ensureStreamUser(currentUserFirebaseUid, {
      name: currentUserDisplayName,
      image: currentUser.avatar,
      appRole: currentUser.role, // Store app role in Stream user metadata
      username: currentUser.username, // Store username as single source of truth
    });

    await ensureStreamUser(otherUserFirebaseUid, {
      name: otherUserDisplayName,
      image: otherUser.avatar,
      appRole: otherUser.role, // Store app role in Stream user metadata
      username: otherUser.username, // Store username as single source of truth
    });


    // Generate deterministic channel ID using Firebase UIDs (sorted)
    const channelId = generateChannelId(currentUserFirebaseUid, otherUserFirebaseUid);

    // Get Stream client
    const client = getStreamClient();

    // Get chat policy for channel (based on current user's role)
    const chatPolicy = getChatPolicyForRole(currentUser.role);

    // Create or get channel
    // Store policy in channel data for frontend to read
    const channel = client.channel('messaging', channelId, {
      members: [currentUserFirebaseUid, otherUserFirebaseUid],
      created_by_id: currentUserFirebaseUid,
      name: `Chat with ${(otherUser.username && otherUser.username.trim().length > 0) ? otherUser.username : 'User'}`,
      data: {
        // Channel-level policy
        allow_user_media: chatPolicy.allowImages || chatPolicy.allowVideos,
        allow_creator_media: true, // Creators can always send media
        // Store text pattern as string (RegExp doesn't serialize)
        allowed_text_pattern: chatPolicy.allowedTextPattern?.source || '^[0-5\\s]*$',
      },
    });

    // Create channel (idempotent - won't error if already exists)
    await channel.create();

    // Get channel state to return latest info
    await channel.watch();

    res.json({
      success: true,
      data: {
        channelId,
        type: 'messaging',
        cid: channel.cid,
      },
    });
  } catch (error) {
    console.error('❌ [CHAT] Error creating/getting channel:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create or get channel',
    });
  }
};
