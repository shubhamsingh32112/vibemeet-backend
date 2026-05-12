/**
 * Lightweight metric helpers for the image pipeline.
 * Wraps the shared monitoring service so image events are surfaced
 * alongside billing/availability metrics in the `/metrics` dashboard.
 */

import { recordImageMetric as record } from '../../utils/monitoring';

type Tags = Record<string, string | number | boolean | undefined>;

function sanitize(tags?: Tags): Record<string, string> {
  if (!tags) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}

export function recordImageMetric(name: string, value: number, tags?: Tags): void {
  record(name, value, sanitize(tags));
}

export function bumpImageCounter(name: string, tags?: Tags): void {
  recordImageMetric(name, 1, tags);
}
