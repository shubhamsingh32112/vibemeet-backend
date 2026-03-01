import crypto from 'crypto';
import { getStreamClient } from '../../config/stream';

function generateUserCreatorChannelId(uid1: string, uid2: string): string {
  const [a, b] = [uid1, uid2].sort();
  const hash = crypto
    .createHash('sha256')
    .update(`${a}:${b}`)
    .digest('hex')
    .slice(0, 32);
  return `uc_${hash}`;
}

function formatDurationLabel(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  
  // Show duration in minutes format (e.g., "5 minutes", "1 minute", "30 seconds")
  if (mins <= 0) {
    return `${secs} second${secs === 1 ? '' : 's'}`;
  }
  if (secs === 0) {
    return `${mins} minute${mins === 1 ? '' : 's'}`;
  }
  // Show both minutes and seconds for calls under 1 hour
  if (mins < 60) {
    return `${mins} minute${mins === 1 ? '' : 's'} ${secs} second${secs === 1 ? '' : 's'}`;
  }
  // For calls over 1 hour, show hours and minutes
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  if (remainingMins === 0) {
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${hours} hour${hours === 1 ? '' : 's'} ${remainingMins} minute${remainingMins === 1 ? '' : 's'}`;
}

export async function postCallActivityToChat(params: {
  callId: string;
  userFirebaseUid: string;
  creatorFirebaseUid: string;
  creatorName: string;
  durationSeconds: number;
  coinsSpent: number;
}): Promise<void> {
  const {
    callId,
    userFirebaseUid,
    creatorFirebaseUid,
    creatorName,
    durationSeconds,
    coinsSpent,
  } = params;

  const streamClient = getStreamClient();
  const channelId = generateUserCreatorChannelId(userFirebaseUid, creatorFirebaseUid);
  const channel = streamClient.channel('messaging', channelId, {
    members: [userFirebaseUid, creatorFirebaseUid],
    created_by_id: userFirebaseUid,
    name: creatorName,
  });

  try {
    await channel.create();
  } catch {
    // Channel may already exist. Continue to message send.
  }

  const durationLabel = formatDurationLabel(durationSeconds);
  await channel.sendMessage({
    id: `call_activity_${callId}`,
    type: 'system',
    text: `Video call completed (${durationLabel}) • ${coinsSpent} coin${coinsSpent === 1 ? '' : 's'} spent`,
  });
}

