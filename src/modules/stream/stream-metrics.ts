import { monitoring } from '../../utils/monitoring';

export function bumpStreamCounter(
  name: string,
  tags?: Record<string, string>,
): void {
  monitoring.recordMetric(`stream.${name}`, 1, tags);
}

export function recordStreamMetric(
  name: string,
  value: number,
  tags?: Record<string, string>,
): void {
  monitoring.recordMetric(`stream.${name}`, value, tags);
}

export function recordPlaybackRefreshMetric(
  outcome: 'ok' | 'denied' | 'error' | 'unavailable',
): void {
  monitoring.recordMetric('playback.refresh', 1, { outcome });
}

export function recordVideoPlaybackMetric(
  name: string,
  value: number,
  tags?: Record<string, string>,
): void {
  monitoring.recordMetric(`video.playback.${name}`, value, tags);
}

export function bumpVideoPlaybackCounter(
  name: string,
  tags?: Record<string, string>,
): void {
  monitoring.recordMetric(`video.playback.${name}`, 1, tags);
}
