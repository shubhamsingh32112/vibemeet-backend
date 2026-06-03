#!/usr/bin/env node
/**
 * Poll GET /metrics during canary and log alerts + billing/moments health.
 *
 * Usage:
 *   node scripts/canary-metrics-poll.mjs --url https://api.example.com --token SECRET
 *   node scripts/canary-metrics-poll.mjs --url http://localhost:3000 --interval 30 --once
 */

import fs from 'fs';

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const baseUrl = (getArg('--url', process.env.API_URL || 'http://localhost:3000') || '').replace(
  /\/$/,
  '',
);
const token = getArg('--token', process.env.METRICS_TOKEN || '');
const intervalSec = Number(getArg('--interval', '60'));
const outPath = getArg('--out', '');
const once = args.includes('--once');

async function poll() {
  const headers = { Accept: 'application/json' };
  if (token) headers['X-Metrics-Token'] = token;

  const res = await fetch(`${baseUrl}/metrics`, { headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`metrics ${res.status}: ${JSON.stringify(body)}`);
  }

  const alerts = body?.alerts?.active ?? [];
  const billing = body?.billing ?? {};
  const moments = body?.moments ?? {};
  const line = {
    ts: new Date().toISOString(),
    alerts,
    backpressureStage: billing?.backpressure?.currentStage,
    tickDriftP95: billing?.tickDriftMs?.p95Ms,
    bullmqLag: billing?.bullmq?.queueLagAvgMs,
    recovery: billing?.recovery,
    momentsFanoutQueueDepth: moments?.fanout?.queueDepth,
    momentsFanoutDurationP95: moments?.fanout?.durationMs?.p95Ms,
    momentsFanoutFailed: moments?.fanout?.failedSum,
    momentsWarmQueueDepth: moments?.warm?.queueDepth,
    cfBreakerOpen: moments?.cloudflare?.breakerOpenSum,
    playbackTokenRefreshFail: moments?.playback?.tokenRefreshFailSum,
    playbackPlayerError: moments?.playback?.playerErrorSum,
    playbackStartupP95: moments?.playback?.startupP95Ms,
  };

  console.log(JSON.stringify(line));

  if (outPath) {
    fs.appendFileSync(outPath, `${JSON.stringify(line)}\n`);
  }

  if (alerts.length > 0) {
    console.error(`[canary-metrics] ALERTS: ${alerts.join(', ')}`);
    return 1;
  }
  return 0;
}

async function main() {
  let exitCode = 0;
  do {
    try {
      const code = await poll();
      if (code !== 0) exitCode = code;
    } catch (e) {
      console.error('[canary-metrics] poll failed:', e.message || e);
      exitCode = 1;
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  } while (!once);

  process.exit(exitCode);
}

main();
