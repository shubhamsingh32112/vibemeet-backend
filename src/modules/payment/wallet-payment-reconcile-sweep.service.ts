import { randomUUID } from 'crypto';
import { getRedis } from '../../config/redis';
import { logError, logInfo } from '../../utils/logger';
import { recordPaymentMetric } from '../../utils/monitoring';
import { runPaymentErrorCheck } from '../admin/admin-payment-error-check.service';
import { reconcileCapturedWalletPayment } from './wallet-payment-reconcile.service';

const LOCK_KEY = 'lock:payment:wallet_reconcile_sweep';
const LOCK_TTL_MS = Math.max(
  10_000,
  parseInt(process.env.PAYMENT_RECONCILE_SWEEP_LOCK_TTL_MS || '120000', 10) || 120_000,
);
const INTERVAL_MS = Math.max(
  30_000,
  parseInt(process.env.PAYMENT_RECONCILE_SWEEP_INTERVAL_MS || '300000', 10) || 300_000,
);
const LOOKBACK_MS = Math.max(
  60_000,
  parseInt(process.env.PAYMENT_RECONCILE_SWEEP_LOOKBACK_MS || String(6 * 60 * 60 * 1000), 10) ||
    6 * 60 * 60 * 1000,
);
const MAX_PER_TICK = Math.max(
  1,
  parseInt(process.env.PAYMENT_RECONCILE_SWEEP_BATCH || '25', 10) || 25,
);

const RELEASE_LOCK_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

let sweepTimer: NodeJS.Timeout | null = null;

async function releaseLock(token: string): Promise<void> {
  try {
    await getRedis().eval(RELEASE_LOCK_LUA, 1, LOCK_KEY, token);
  } catch {
    // ignore
  }
}

export async function runWalletPaymentReconcileSweep(): Promise<{
  scanned: number;
  attempted: number;
  credited: number;
  alreadyCompleted: number;
  skipped: number;
  failed: number;
}> {
  const to = new Date();
  const from = new Date(to.getTime() - LOOKBACK_MS);
  const check = await runPaymentErrorCheck({ from, to });
  const candidates = check.paidNoCoins.filter(
    (row) =>
      row.orderId &&
      (row.issue === 'NO_COIN_TRANSACTION' ||
        row.issue === 'PAID_BUT_PENDING' ||
        row.issue === 'PAID_BUT_FAILED'),
  );

  let credited = 0;
  let alreadyCompleted = 0;
  let skipped = 0;
  let failed = 0;
  let attempted = 0;

  for (const row of candidates.slice(0, MAX_PER_TICK)) {
    if (!row.orderId) continue;
    attempted += 1;
    const result = await reconcileCapturedWalletPayment({
      orderId: row.orderId,
      paymentId: row.paymentId,
      source: 'sweep',
    });
    if (result.outcome === 'credited') credited += 1;
    else if (result.outcome === 'already_completed') alreadyCompleted += 1;
    else if (result.outcome === 'skipped') skipped += 1;
    else failed += 1;
  }

  recordPaymentMetric('reconcile.sweep_scanned', check.capturedWalletPayments);
  recordPaymentMetric('reconcile.sweep_attempted', attempted);
  recordPaymentMetric('reconcile.sweep_credited', credited);
  recordPaymentMetric('reconcile.sweep_failed', failed);

  return {
    scanned: check.capturedWalletPayments,
    attempted,
    credited,
    alreadyCompleted,
    skipped,
    failed,
  };
}

async function runSweepPassWithLock(): Promise<void> {
  const redis = getRedis();
  const token = randomUUID();
  const lockResult = await redis.set(LOCK_KEY, token, 'PX', LOCK_TTL_MS, 'NX');
  if (lockResult !== 'OK') {
    recordPaymentMetric('reconcile.sweep_lock_busy', 1);
    return;
  }

  const heartbeat = setInterval(() => {
    redis.set(LOCK_KEY, token, 'PX', LOCK_TTL_MS, 'XX').catch(() => {});
  }, Math.max(1000, Math.floor(LOCK_TTL_MS / 3)));

  try {
    const startedAt = Date.now();
    const result = await runWalletPaymentReconcileSweep();
    recordPaymentMetric('reconcile.sweep_tick_ms', Date.now() - startedAt);
    if (result.attempted > 0) {
      logInfo('Wallet payment reconcile sweep completed', result);
    }
  } catch (error) {
    recordPaymentMetric('reconcile.sweep_tick_failed', 1);
    logError('Wallet payment reconcile sweep failed', error);
  } finally {
    clearInterval(heartbeat);
    await releaseLock(token);
  }
}

export function startWalletPaymentReconcileSweepWorker(): void {
  if (sweepTimer) {
    logInfo('Wallet payment reconcile sweep already running');
    return;
  }

  logInfo('Starting wallet payment reconcile sweep worker', {
    intervalMs: INTERVAL_MS,
    lookbackMs: LOOKBACK_MS,
    batch: MAX_PER_TICK,
  });

  runSweepPassWithLock().catch((error) => {
    logError('Initial wallet reconcile sweep failed', error);
  });

  sweepTimer = setInterval(() => {
    runSweepPassWithLock().catch((error) => {
      logError('Scheduled wallet reconcile sweep failed', error);
    });
  }, INTERVAL_MS);
}

export function stopWalletPaymentReconcileSweepWorker(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
  logInfo('Stopped wallet payment reconcile sweep worker');
}
