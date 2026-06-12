import type { Server as HttpServer } from 'http';
import type { Server } from 'socket.io';
import mongoose from 'mongoose';
import {
  getServiceRole,
  runsBillingWorkers,
  runsMomentsWorkers,
  runsImageWorkers,
  runsHttpApi,
} from '../config/service-role';
import { cleanupBillingIntervals } from '../modules/billing/billing.gateway';
import { stopReconciliationJob } from '../modules/billing/billing-reconciliation';
import { stopBillingWatchdog } from '../modules/billing/billing-watchdog.service';
import { stopStaffWalletReconciliationScheduler } from '../modules/billing/staff-wallet-reconciliation.scheduler';
import { stopDomainEventWorker } from '../modules/events/domain-event.worker';
import { stopCallReconciliationJob } from '../modules/video/call-reconciliation';
import { stopVipReconciliationJob } from '../modules/vip/vip-scheduling.reconciliation';
import { stopPaymentWebhookRetryWorker } from '../modules/payment/payment-webhook-retry.service';
import { stopImagePipelineWorkers } from '../modules/images/images.bootstrap';
import { stopMomentsWorkers } from '../modules/moments/moments.bootstrap';
import { clearEventLoopProbe } from './bootstrap-core';
import { logInfo } from '../utils/logger';
import {
  flushOwnedSessionsToMongoOnShutdown,
  markShuttingDown,
} from '../modules/billing/billing-shutdown.service';

const SHUTDOWN_HTTP_MS = parseInt(process.env.SHUTDOWN_HTTP_MS || '30000', 10);
const SHUTDOWN_BULLMQ_MS = parseInt(process.env.SHUTDOWN_BULLMQ_MS || '60000', 10);
const SHUTDOWN_SOCKETIO_MS = parseInt(process.env.SOCKETIO_CLOSE_MS || '15000', 10);

let httpServerRef: HttpServer | null = null;
let ioRef: Server | null = null;
let shuttingDown = false;

export function registerRuntimeServers(httpServer: HttpServer, io: Server | null): void {
  httpServerRef = httpServer;
  ioRef = io;
}

function closeHttpServer(timeoutMs: number): Promise<void> {
  const server = httpServerRef;
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logInfo('HTTP shutdown timeout elapsed', { timeoutMs });
      resolve();
    }, timeoutMs);
    server.close((err) => {
      clearTimeout(timer);
      if (err) {
        logInfo('httpServer.close completed with error', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      resolve();
    });
  });
}

async function closeSocketIo(): Promise<void> {
  if (!ioRef) return;
  await Promise.race([
    new Promise<void>((resolve) => {
      ioRef!.close(() => resolve());
    }),
    new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_SOCKETIO_MS)),
  ]);
}

async function stopBillingWorkersWithTimeout(timeoutMs: number): Promise<void> {
  await Promise.race([
    cleanupBillingIntervals(),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

export { isShuttingDown } from '../modules/billing/billing-shutdown.service';

async function runRoleShutdown(): Promise<void> {
  if (shuttingDown) return;
  markShuttingDown();
  shuttingDown = true;
  const role = getServiceRole();
  logInfo('Role-aware shutdown starting', { serviceRole: role, signal: 'shutdown' });

  await flushOwnedSessionsToMongoOnShutdown().catch(() => {});

  if (runsHttpApi()) {
    await closeHttpServer(SHUTDOWN_HTTP_MS);
    await closeSocketIo();
  }

  if (runsBillingWorkers()) {
    stopReconciliationJob();
    stopBillingWatchdog();
    stopStaffWalletReconciliationScheduler();
    stopDomainEventWorker();
    stopCallReconciliationJob();
    stopVipReconciliationJob();
    stopPaymentWebhookRetryWorker();
    await stopBillingWorkersWithTimeout(SHUTDOWN_BULLMQ_MS);
  }

  if (runsMomentsWorkers()) {
    stopMomentsWorkers();
  }

  if (runsImageWorkers()) {
    await stopImagePipelineWorkers().catch(() => {});
  }

  if (!runsHttpApi() && httpServerRef) {
    await closeHttpServer(SHUTDOWN_HTTP_MS);
  }

  clearEventLoopProbe();
  await mongoose.disconnect().catch(() => {});
}

export function registerShutdownHandlers(): void {
  const onShutdown = async (signal: string, exitCode: number) => {
    logInfo(`${signal} received — cleaning up`, { signal, serviceRole: getServiceRole() });
    try {
      await runRoleShutdown();
    } catch (err) {
      logInfo('Shutdown error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    process.exit(exitCode);
  };

  process.on('SIGTERM', () => {
    void onShutdown('SIGTERM', 0);
  });
  process.on('SIGINT', () => {
    void onShutdown('SIGINT', 0);
  });
  process.on('uncaughtException', (error) => {
    logInfo('Uncaught exception - cleaning up and exiting', {
      error: error instanceof Error ? error.message : String(error),
    });
    void onShutdown('uncaughtException', 1);
  });
}
