/**
 * Client-side video playback telemetry sink.
 *
 * Endpoint: POST /metrics/video-playback
 */

import type { Request, Response } from 'express';
import { logWarning } from '../../utils/logger';
import {
  bumpVideoPlaybackCounter,
  recordVideoPlaybackMetric,
} from '../stream/stream-metrics';

const MAX_SAMPLES_PER_BATCH = 50;
const MAX_LATENCY_MS = 120_000;
const MAX_WEIGHT = 10_000;
const CONTEXT_RE = /^[a-z][a-zA-Z0-9]{0,31}$/;
const EVENT_RE = /^[a-z][a-zA-Z0-9_]{0,47}$/;

interface RawSample {
  event?: unknown;
  context?: unknown;
  valueMs?: unknown;
  weight?: unknown;
  completed?: unknown;
  watchedPct?: unknown;
  httpStatus?: unknown;
  reason?: unknown;
  phase?: unknown;
  errorClass?: unknown;
  sampledAt?: unknown;
}

interface ValidSample {
  event: string;
  context: string;
  valueMs: number;
  weight: number;
  completed?: boolean;
  watchedPct?: number;
  httpStatus?: number;
  reason?: string;
  phase?: string;
  errorClass?: string;
}

function validateSample(raw: RawSample): ValidSample | null {
  if (!raw || typeof raw !== 'object') return null;

  const event = typeof raw.event === 'string' ? raw.event.trim() : '';
  if (!EVENT_RE.test(event)) return null;

  const context = typeof raw.context === 'string' ? raw.context.trim() : 'reels';
  if (!CONTEXT_RE.test(context)) return null;

  const valueMs = Number(raw.valueMs ?? 0);
  if (!Number.isFinite(valueMs) || valueMs < 0 || valueMs > MAX_LATENCY_MS) return null;

  const weight = Number(raw.weight ?? 1);
  if (!Number.isFinite(weight) || weight < 1 || weight > MAX_WEIGHT) return null;

  const sample: ValidSample = { event, context, valueMs, weight };

  if (raw.completed !== undefined) {
    if (typeof raw.completed !== 'boolean') return null;
    sample.completed = raw.completed;
  }
  if (raw.watchedPct !== undefined) {
    const watchedPct = Number(raw.watchedPct);
    if (!Number.isFinite(watchedPct) || watchedPct < 0 || watchedPct > 100) return null;
    sample.watchedPct = watchedPct;
  }
  if (raw.httpStatus !== undefined) {
    const httpStatus = Number(raw.httpStatus);
    if (!Number.isFinite(httpStatus) || httpStatus < 0 || httpStatus > 599) return null;
    sample.httpStatus = httpStatus;
  }
  if (raw.reason !== undefined) {
    if (typeof raw.reason !== 'string' || raw.reason.length > 64) return null;
    sample.reason = raw.reason;
  }
  if (raw.phase !== undefined) {
    if (typeof raw.phase !== 'string' || raw.phase.length > 32) return null;
    sample.phase = raw.phase;
  }
  if (raw.errorClass !== undefined) {
    if (typeof raw.errorClass !== 'string' || raw.errorClass.length > 64) return null;
    sample.errorClass = raw.errorClass;
  }

  return sample;
}

function ingestSample(sample: ValidSample): void {
  const tags: Record<string, string> = { context: sample.context };

  switch (sample.event) {
    case 'startup':
      recordVideoPlaybackMetric('startup_ms', sample.valueMs, tags);
      recordVideoPlaybackMetric('weighted_count', sample.weight, { ...tags, event: 'startup' });
      break;
    case 'buffering':
      recordVideoPlaybackMetric('buffering_ms', sample.valueMs, tags);
      recordVideoPlaybackMetric('weighted_count', sample.weight, { ...tags, event: 'buffering' });
      break;
    case 'completion':
      recordVideoPlaybackMetric('completion', sample.completed ? 1 : 0, tags);
      if (sample.watchedPct !== undefined) {
        recordVideoPlaybackMetric('watched_pct', sample.watchedPct, tags);
      }
      recordVideoPlaybackMetric('weighted_count', sample.weight, { ...tags, event: 'completion' });
      break;
    case 'token_refresh_fail':
      bumpVideoPlaybackCounter('token_refresh_fail', {
        ...tags,
        reason: sample.reason ?? 'unknown',
        httpStatus: String(sample.httpStatus ?? 0),
      });
      break;
    case 'player_error':
      bumpVideoPlaybackCounter('player_error', {
        ...tags,
        phase: sample.phase ?? 'unknown',
        errorClass: sample.errorClass ?? 'unknown',
      });
      break;
    default:
      bumpVideoPlaybackCounter('invalid_event', { event: sample.event });
  }
}

export async function postVideoPlaybackMetricsHandler(req: Request, res: Response): Promise<void> {
  const samples = Array.isArray(req.body?.samples) ? (req.body.samples as RawSample[]) : null;
  if (!samples || samples.length === 0) {
    res.status(400).json({
      success: false,
      code: 'INVALID_SAMPLES',
      error: 'body.samples must be a non-empty array',
    });
    return;
  }

  if (samples.length > MAX_SAMPLES_PER_BATCH) {
    res.status(413).json({
      success: false,
      code: 'TOO_MANY_SAMPLES',
      error: `samples cannot exceed ${MAX_SAMPLES_PER_BATCH} per batch`,
    });
    return;
  }

  let accepted = 0;
  let rejected = 0;

  for (const raw of samples) {
    const sample = validateSample(raw);
    if (!sample) {
      rejected += 1;
      bumpVideoPlaybackCounter('invalid_sample');
      continue;
    }
    accepted += 1;
    ingestSample(sample);
  }

  if (rejected > 0) {
    logWarning('video-playback-metrics: dropped malformed samples', {
      rejected,
      accepted,
      total: samples.length,
    });
  }

  res.status(202).json({ success: true, accepted, rejected });
}
