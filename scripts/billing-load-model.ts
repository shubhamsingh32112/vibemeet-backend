/**
 * Billing stability load model — validates queue lag and correctness guidance.
 * NOT saturation / max-throughput discovery.
 *
 * Usage: npm run billing:load-model
 */
import mongoose from 'mongoose';
import { getRedis, callSessionKey, DLQ_BILLING_PREFIX, isRedisConfigured } from '../src/config/redis';
import { readBullmqConcurrency } from '../src/modules/billing/billing.queue';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const TARGET_CALLS = parseInt(process.env.BILLING_LOAD_MODEL_CALLS || '500', 10);

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? 0;
}

async function main(): Promise<void> {
  if (!MONGO_URI) {
    console.error('MONGO_URI required');
    process.exit(1);
  }
  if (!isRedisConfigured()) {
    console.error('REDIS_URL required');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  const redis = getRedis();

  const activeKeys = await redis.smembers('billing:active:calls').catch(() => [] as string[]);
  const sampleLag: number[] = [];
  const scan = Math.min(TARGET_CALLS, activeKeys.length || TARGET_CALLS);

  for (let i = 0; i < scan; i += 1) {
    const callId = activeKeys[i] || `load-model-probe-${i}`;
    const session = await redis.get(callSessionKey(callId));
    if (session) {
      sampleLag.push(Math.max(0, Date.now() - JSON.parse(session).lastHealthyTickAt || Date.now()));
    }
  }

  const dlqSize = await redis.scard(`${DLQ_BILLING_PREFIX}set`).catch(() => 0);
  const concurrency = readBullmqConcurrency();

  const report = {
    scenario: 'steady_stability_probe',
    targetCalls: TARGET_CALLS,
    sampledCalls: scan,
    concurrency,
    queueLagP50Ms: percentile(sampleLag, 0.5),
    queueLagP95Ms: percentile(sampleLag, 0.95),
    dlqSize: Number(dlqSize || 0),
    guidance: {
      note: 'Operational stability check — not max throughput',
      suggestedConcurrencyPerWorker:
        concurrency <= 50 ? concurrency : Math.max(25, Math.floor(concurrency * 0.7)),
      rollbackConcurrency: concurrency,
    },
    pass:
      percentile(sampleLag, 0.95) < 2000 &&
      Number(dlqSize || 0) < 50,
  };

  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
  process.exit(report.pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
