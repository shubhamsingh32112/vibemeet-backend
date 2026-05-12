/**
 * Client-side image render-latency telemetry sink.
 *
 * Endpoint: POST /metrics/image-render
 * Body: {
 *   samples: Array<{
 *     variant:    string,          // e.g. "avatarMd" | "galleryThumb"
 *     latencyMs:  number,          // wall-clock time from first paint trigger -> first frame
 *     decoded:    boolean,         // true once ImageStreamListener fired with synchronousCall=false
 *     weight:     number,          // inverse-sample-rate weight (>=1)
 *     sampledAt?: number,          // optional client epoch-ms timestamp
 *   }>
 * }
 *
 * Records two metric families against the existing monitoring service:
 *   image.render.latency_ms     (value = latencyMs, tags = { variant, decoded })
 *   image.render.weighted_count (value = weight,    tags = { variant, decoded })
 *
 * Validation rules:
 *   - samples must be a non-empty array (<= MAX_SAMPLES_PER_BATCH)
 *   - latencyMs ∈ [0, 60_000]
 *   - weight    ∈ [1, 10_000]
 *   - variant   must match /^[a-z][a-zA-Z0-9]{0,31}$/  (alphanumeric only,
 *               must start with lowercase — matches Cloudflare's variant-name
 *               rules so we never accept a sample that wouldn't correspond
 *               to a real variant)
 *   - decoded   must be a boolean
 *
 * Anything outside these bounds is dropped silently (counter:
 * `image.render.invalid_sample`) so a misbehaving client cannot poison the
 * dashboard.
 */

import type { Request, Response } from 'express';
import {
  bumpImageCounter,
  recordImageMetric,
} from '../images/image-metrics';
import { logWarning } from '../../utils/logger';

const MAX_SAMPLES_PER_BATCH = 50;
const MAX_LATENCY_MS = 60_000;
const MAX_WEIGHT = 10_000;
// Cloudflare Images only allows alphanumeric variant names (no `-` / `_`),
// so the wire-format names are camelCase (avatarMd, galleryThumb, ...).
// Telemetry tags ship the same identifiers we'd see in URL paths, so this
// regex deliberately matches the same shape as the Cloudflare-side names.
const VARIANT_RE = /^[a-z][a-zA-Z0-9]{0,31}$/;

interface RawSample {
  variant?: unknown;
  latencyMs?: unknown;
  decoded?: unknown;
  weight?: unknown;
  sampledAt?: unknown;
}

interface ValidSample {
  variant: string;
  latencyMs: number;
  decoded: boolean;
  weight: number;
}

function validateSample(raw: RawSample): ValidSample | null {
  if (!raw || typeof raw !== 'object') return null;

  const variant = typeof raw.variant === 'string' ? raw.variant.trim() : '';
  if (!VARIANT_RE.test(variant)) return null;

  const latencyMs = Number(raw.latencyMs);
  if (!Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > MAX_LATENCY_MS) return null;

  if (typeof raw.decoded !== 'boolean') return null;

  const weight = Number(raw.weight);
  if (!Number.isFinite(weight) || weight < 1 || weight > MAX_WEIGHT) return null;

  return {
    variant,
    latencyMs,
    decoded: raw.decoded,
    weight,
  };
}

export async function postImageRenderMetricsHandler(req: Request, res: Response): Promise<void> {
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
      bumpImageCounter('render.invalid_sample');
      continue;
    }
    accepted += 1;
    const tags = {
      variant: sample.variant,
      decoded: sample.decoded ? 'true' : 'false',
    };
    recordImageMetric('render.latency_ms', sample.latencyMs, tags);
    recordImageMetric('render.weighted_count', sample.weight, tags);
  }

  if (rejected > 0) {
    logWarning('image-render-metrics: dropped malformed samples', {
      rejected,
      accepted,
      total: samples.length,
    });
  }

  res.status(202).json({
    success: true,
    accepted,
    rejected,
  });
}
