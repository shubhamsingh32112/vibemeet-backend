import axios from 'axios';
import { generateServerSideToken } from '../../config/stream-video';
import { featureFlags } from '../../config/feature-flags';
import { recordBillingMetric } from '../../utils/monitoring';

/**
 * Single implementation of Stream Video mark_ended — used by force-terminate and retry worker.
 */
export type StreamMarkEndedResult =
  | { outcome: 'ended'; statusCode?: number }
  | { outcome: 'not_found'; statusCode: 404 };

export async function markStreamCallEnded(
  callId: string,
  reason: string
): Promise<StreamMarkEndedResult> {
  const apiKey = process.env.STREAM_API_KEY;
  if (!apiKey) {
    throw new Error('STREAM_API_KEY missing');
  }

  const token = generateServerSideToken();
  const callType = process.env.STREAM_CALL_TYPE || 'default';
  const url = `https://video.stream-io-api.com/v1/calls/${encodeURIComponent(
    callType
  )}/${encodeURIComponent(callId)}/mark_ended?api_key=${encodeURIComponent(apiKey)}`;

  try {
    const response = await axios.post(
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
    recordBillingMetric('stream_mark_ended_result_total', 1, { result: 'success' });
    return { outcome: 'ended', statusCode: response.status };
  } catch (error) {
    const responseStatus =
      axios.isAxiosError(error) && error.response?.status ? error.response.status : undefined;
    const responseCode =
      axios.isAxiosError(error) && error.response?.data && typeof error.response.data === 'object'
        ? Number((error.response.data as { code?: unknown }).code)
        : undefined;
    if (
      featureFlags.billingTermination404IdempotentEnabled &&
      (responseStatus === 404 || responseCode === 4)
    ) {
      recordBillingMetric('stream_mark_ended_result_total', 1, { result: 'not_found' });
      return { outcome: 'not_found', statusCode: 404 };
    }
    recordBillingMetric('stream_mark_ended_result_total', 1, { result: 'error' });
    throw error;
  }
}
