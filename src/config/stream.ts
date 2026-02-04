import { StreamChat } from 'stream-chat';

/**
 * Stream Chat client singleton
 * Initialized once and reused across the application
 */
let streamClient: StreamChat | null = null;

/**
 * Get or initialize Stream Chat client
 */
export const getStreamClient = (): StreamChat => {
  if (!streamClient) {
    const apiKey = process.env.STREAM_API_KEY;
    const apiSecret = process.env.STREAM_API_SECRET;

    if (!apiKey || !apiSecret) {
      throw new Error(
        'Stream Chat credentials not configured. Please set STREAM_API_KEY and STREAM_API_SECRET environment variables.'
      );
    }

    streamClient = StreamChat.getInstance(apiKey, apiSecret);
    console.log('✅ [STREAM] Stream Chat client initialized');
  }

  return streamClient;
};

/**
 * Ensure Stream user exists (idempotent)
 * Maps Firebase UID → Stream user ID
 * 
 * IMPORTANT: Do NOT set Stream role - Stream roles (user | admin | moderator) are
 * completely separate from app roles (user | creator | admin). Always let Stream
 * default to "user" role. Use extraData for app-specific roles.
 */
export const ensureStreamUser = async (
  firebaseUid: string,
  userData: {
    name?: string;
    image?: string;
    appRole?: 'user' | 'creator' | 'admin';
    username?: string; // Username from MongoDB (single source of truth)
  }
): Promise<void> => {
  try {
    const client = getStreamClient();
    
    // Do NOT set role - Stream roles are separate from app roles
    // Stream will default to "user" role which is correct for all users
    // Store app role and username in extraData for business logic
    await client.upsertUser({
      id: firebaseUid,
      name: userData.name || 'User',
      image: userData.image,
      // role is intentionally omitted - Stream defaults to "user"
      extraData: {
        appRole: userData.appRole || 'user', // Store app role in metadata
        username: userData.username, // Store username as single source of truth
      },
    });

    console.log(`✅ [STREAM] User ensured: ${firebaseUid} (appRole: ${userData.appRole || 'user'}, username: ${userData.username || 'N/A'})`);
  } catch (error) {
    console.error(`❌ [STREAM] Failed to ensure user ${firebaseUid}:`, error);
    throw error;
  }
};
