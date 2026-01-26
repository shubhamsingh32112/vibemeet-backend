// Agora RTC Token Generator
// Note: agora-access-token is deprecated, but still works
// For new projects, consider using agora-token package
import { RtcTokenBuilder, RtcRole } from 'agora-access-token';

export function generateAgoraToken(
  channelName: string,
  uid: number,
  expirationTimeInSeconds: number = 3600 // 1 hour default
): string {
  const appId = process.env.AGORA_APP_ID;
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;

  if (!appId || !appCertificate) {
    throw new Error('Agora credentials not configured. Set AGORA_APP_ID and AGORA_APP_CERTIFICATE in .env');
  }

  try {
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;
    
    // Generate token with PUBLISHER role (can publish and subscribe)
    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      uid,
      RtcRole.PUBLISHER,
      privilegeExpiredTs
    );

    console.log(`✅ [AGORA] Token generated for channel: ${channelName}, uid: ${uid}`);
    return token;
  } catch (error) {
    console.error('❌ [AGORA] Token generation error:', error);
    throw new Error('Failed to generate Agora token');
  }
}
