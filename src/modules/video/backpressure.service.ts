import { monitoring } from '../../utils/monitoring';

/**
 * Extremely simple back-pressure heuristic for calls.
 *
 * We use recent in-memory metrics from the MonitoringService to decide if
 * the system is currently in a degraded state for new billable calls.
 *
 * This is deliberately conservative and easy to tune:
 * - If we see many recent billing / webhook errors, we temporarily
 *   reject new call initiations with a clear 503-style error.
 */

const ERROR_WINDOW_MS = 60_000; // 1 minute sliding window
const MAX_RECENT_ERRORS = 20; // threshold before we start rejecting new calls

export function shouldRejectNewCallsDueToBackpressure(): boolean {
  const recentErrors = monitoring.getRecentErrors(200);
  const now = Date.now();

  const recentRelevantErrors = recentErrors.filter((err) => {
    if (now - err.timestamp > ERROR_WINDOW_MS) return false;
    const msg = err.message.toLowerCase();
    return (
      msg.includes('billing') ||
      msg.includes('settlement') ||
      msg.includes('webhook') ||
      msg.includes('redis') ||
      msg.includes('mongo')
    );
  });

  return recentRelevantErrors.length >= MAX_RECENT_ERRORS;
}

