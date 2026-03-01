import jwt from 'jsonwebtoken';
import crypto from 'crypto';

/**
 * Stream Video configuration and utilities
 * 
 * Stream Video uses JWT tokens for authentication.
 * Tokens must be generated server-side using the API secret.
 */

/**
 * Generate Stream Video JWT token
 * 
 * @param userId - User ID (Firebase UID)
 * @param role - Stream Video role: 'user' or 'call_member'
 * @returns JWT token string
 */
export const generateStreamVideoToken = (
  userId: string,
  role: 'user' | 'call_member'
): string => {
  const apiKey = process.env.STREAM_API_KEY;
  const apiSecret = process.env.STREAM_VIDEO_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error(
      'Stream Video credentials not configured. Please set STREAM_API_KEY and STREAM_VIDEO_API_SECRET environment variables.'
    );
  }

  // Stream Video JWT payload structure
  // Token expires in 4 hours (reasonable balance between security and UX)
  // Stream SDK will automatically call tokenLoader when token expires
  // Subtract 10 seconds from iat to avoid clock skew issues ("token used before issue")
  const tokenExpiryHours = 4;
  const now = Math.floor(Date.now() / 1000) - 10; // Subtract 10s to handle clock skew
  const payload = {
    iss: apiKey, // Issuer is the API key
    iat: now, // Issued at (with clock skew buffer)
    exp: now + 60 * 60 * tokenExpiryHours, // Expires in 4 hours
    user_id: userId,
    role: role, // 'user' or 'call_member'
    // Only include required scopes - no extra permissions
  };

  // Sign token with API secret
  const token = jwt.sign(payload, apiSecret, {
    algorithm: 'HS256',
  });

  return token;
};

/**
 * Generate server-side JWT token for Stream Video API calls
 * This token is used for server-to-server API calls (not for client SDK)
 * 
 * @returns JWT token string for server-side API authentication
 */
export const generateServerSideToken = (): string => {
  const apiKey = process.env.STREAM_API_KEY;
  const apiSecret = process.env.STREAM_VIDEO_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error(
      'Stream Video credentials not configured. Please set STREAM_API_KEY and STREAM_VIDEO_API_SECRET environment variables.'
    );
  }

  // Server-side token for API calls
  // No user_id needed for server-side operations
  // Subtract 10 seconds from iat to avoid clock skew issues ("token used before issue")
  const now = Math.floor(Date.now() / 1000) - 10; // Subtract 10s to handle clock skew
  const payload = {
    iss: apiKey,
    iat: now, // Issued at (with clock skew buffer)
    exp: now + 60 * 60, // 1 hour expiry
  };

  const token = jwt.sign(payload, apiSecret, {
    algorithm: 'HS256',
  });

  return token;
};

/**
 * Generate call ID matching frontend format
 * 
 * 🔥 FIX 2: Updated to match frontend format: userId_creatorId_timestamp
 * 
 * IMPORTANT: Frontend is the primary source of call IDs (creates calls via Stream SDK).
 * This function is only used in legacy REST endpoint (initiateCall).
 * 
 * Frontend format: userId_creatorId_timestamp (e.g., "abc123_def456_1703001234")
 * - Includes timestamp for uniqueness per call attempt
 * - Total length: ~63 chars (well under Stream's 64-char limit)
 * 
 * @param userId - User's Firebase UID
 * @param creatorId - Creator's MongoDB ObjectId (as string)
 * @returns Call ID in format: userId_creatorId_timestamp
 */
export const generateCallId = (userId: string, creatorId: string): string => {
  // 🔥 FIX 2: Match frontend format: userId_creatorId_timestamp
  const timestamp = Math.floor(Date.now() / 1000); // Unix timestamp in seconds
  return `${userId}_${creatorId}_${timestamp}`;
};
