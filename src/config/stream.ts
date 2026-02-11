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
 * Configure Firebase Cloud Messaging (FCM) push notifications on Stream.
 *
 * This uploads a minimal Firebase service-account credential JSON to Stream
 * so that Stream can send FCM pushes on behalf of this app.
 *
 * Required env vars (same ones used for firebase-admin):
 *   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 *
 * Call once at server startup. Idempotent — safe to call on every boot.
 */
export const configureStreamPush = async (): Promise<void> => {
  try {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      console.warn(
        '⚠️ [STREAM PUSH] Firebase credentials missing in env — push notifications will NOT work.\n' +
        '   Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY in .env'
      );
      return;
    }

    const client = getStreamClient();

    // Build a minimal service-account JSON that Google / Stream can use
    const credentialsJson = JSON.stringify({
      type: 'service_account',
      project_id: projectId,
      private_key: privateKey,
      client_email: clientEmail,
      token_uri: 'https://oauth2.googleapis.com/token',
    });

    await client.updateAppSettings({
      push_config: {
        version: 'v2',
      },
      firebase_config: {
        credentials_json: credentialsJson,
        notification_template: `{"title":"{{ sender.name }}","body":"{{ truncate message.text 250 }}","click_action":"FLUTTER_NOTIFICATION_CLICK","sound":"default"}`,
        data_template: `{"sender":"stream.chat","type":"{{ type }}","id":"{{ message.id }}","channel_type":"{{ channel.type }}","channel_id":"{{ channel.id }}","channel_name":"{{ channel.name }}","message_text":"{{ truncate message.text 250 }}"}`,
      },
    });

    console.log('✅ [STREAM PUSH] Firebase push notifications configured on Stream');
  } catch (error) {
    console.error('❌ [STREAM PUSH] Failed to configure push notifications:', error);
    // Don't throw — push config failure shouldn't block server startup
  }
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
