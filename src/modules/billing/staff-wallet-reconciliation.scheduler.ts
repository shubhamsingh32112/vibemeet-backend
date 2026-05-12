import { logError, logInfo } from '../../utils/logger';
import { reconcileAllStaffBalances } from './staff-wallet-reconciliation.service';

let intervalHandle: NodeJS.Timeout | null = null;

function readIntervalMs(): number {
  const raw = process.env.STAFF_WALLET_RECONCILE_INTERVAL_MS?.trim();
  const n = parseInt(raw ?? '', 10);
  if (Number.isFinite(n) && n >= 60_000) return n;
  return 86_400_000;
}

/**
 * Periodic reconciliation of User.staffCoinsBalance vs StaffWalletLedger sums.
 * Opt-in: set STAFF_WALLET_RECONCILE_ENABLED=true (default off to avoid surprise DB load).
 */
export function startStaffWalletReconciliationScheduler(): void {
  if (process.env.STAFF_WALLET_RECONCILE_ENABLED !== 'true') {
    logInfo('Staff wallet reconciliation scheduler disabled (set STAFF_WALLET_RECONCILE_ENABLED=true)');
    return;
  }
  if (intervalHandle) return;

  const ms = readIntervalMs();
  intervalHandle = setInterval(() => {
    reconcileAllStaffBalances({ dryRun: false }).catch((err) => {
      logError('Scheduled staff wallet reconciliation failed', err as Error);
    });
  }, ms);

  logInfo('Staff wallet reconciliation scheduler started', { intervalMs: ms });
}

export function stopStaffWalletReconciliationScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
