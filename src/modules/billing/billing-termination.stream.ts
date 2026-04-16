import axios from 'axios';
import { generateServerSideToken } from '../../config/stream-video';

/**
 * Single implementation of Stream Video mark_ended — used by force-terminate and retry worker.
 */
export async function markStreamCallEnded(callId: string, reason: string): Promise<void> {
  const apiKey = process.env.STREAM_API_KEY;
  if (!apiKey) {
    throw new Error('STREAM_API_KEY missing');
  }

  const token = generateServerSideToken();
  const callType = process.env.STREAM_CALL_TYPE || 'default';
  const url = `https://video.stream-io-api.com/v1/calls/${encodeURIComponent(
    callType
  )}/${encodeURIComponent(callId)}/mark_ended?api_key=${encodeURIComponent(apiKey)}`;

  await axios.post(
    url,
    { reason },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 6000,
    }
  );
}
