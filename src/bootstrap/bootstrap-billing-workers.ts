import type { Server } from 'socket.io';
import { startGlobalBillingProcessor } from '../modules/billing/billing.gateway';
import { startTerminationRetryWorker } from '../modules/billing/billing-termination.queue';
import { startReconciliationJob } from '../modules/billing/billing-reconciliation';
import { startSettlementFastRetryWorker } from '../modules/billing/billing-settlement-retry.worker';
import { startBillingWatchdog } from '../modules/billing/billing-watchdog.service';
import {
  startStaffWalletReconciliationScheduler,
} from '../modules/billing/staff-wallet-reconciliation.scheduler';
import { startDomainEventWorker } from '../modules/events/domain-event.worker';
import '../modules/events/billing-domain-event-handlers';
import { verifyStartupRecovery } from '../modules/billing/billing-recovery';
import {
  startCallReconciliationJob,
  repairStaleActiveCallSlotsOnStartup,
} from '../modules/video/call-reconciliation';
import { startVipReconciliationJob } from '../modules/vip/vip-scheduling.reconciliation';
import { startPaymentWebhookRetryWorker } from '../modules/payment/payment-webhook-retry.service';
import { logInfo, logError } from '../utils/logger';

export function bootstrapBillingWorkers(io: Server): void {
  startGlobalBillingProcessor(io);
  startTerminationRetryWorker();
  startReconciliationJob(io);
  startSettlementFastRetryWorker(io);
  startBillingWatchdog(io);
  startStaffWalletReconciliationScheduler();
  startDomainEventWorker();
  logInfo('Billing background workers started');

  verifyStartupRecovery(io).catch((err) => {
    logError('Startup recovery verification failed', err);
  });
  repairStaleActiveCallSlotsOnStartup().catch((err) => {
    logError('Startup active-call slot repair failed', err);
  });

  startCallReconciliationJob(io);
  startVipReconciliationJob();
  startPaymentWebhookRetryWorker();
}
