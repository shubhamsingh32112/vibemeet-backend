/**
 * Contract tests for ECS service-role boot split (no live Redis/Mongo required).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');

test('server.ts gates workloads by SERVICE_ROLE bootstrap modules', () => {
  const server = readFileSync(join(root, 'server.ts'), 'utf8');
  assert.ok(server.includes("import './bootstrap/load-env'"));
  assert.ok(server.includes('getServiceRole()'));
  assert.ok(server.includes('runsHttpApi()'));
  assert.ok(server.includes('runsBillingWorkers()'));
  assert.ok(server.includes('bootstrapApiWs'));
  assert.ok(server.includes('bootstrapBillingWorkers'));
  assert.ok(server.includes('registerShutdownHandlers'));
  assert.ok(!server.includes('startGlobalBillingProcessor(io)'));
  assert.ok(!server.includes('startMomentsWorkers()'));
});

test('api-ws bootstrap excludes BullMQ and reconciliation workers', () => {
  const apiWs = readFileSync(join(root, 'bootstrap/bootstrap-api-ws.ts'), 'utf8');
  assert.ok(apiWs.includes('setupBillingGateway'));
  assert.ok(!apiWs.includes('startGlobalBillingProcessor'));
  assert.ok(!apiWs.includes('startReconciliationJob'));
});

test('billing-worker bootstrap owns BullMQ and reconciliation loops', () => {
  const billing = readFileSync(join(root, 'bootstrap/bootstrap-billing-workers.ts'), 'utf8');
  assert.ok(billing.includes('startGlobalBillingProcessor'));
  assert.ok(billing.includes('startReconciliationJob'));
  assert.ok(billing.includes('startBillingWatchdog'));
  assert.ok(billing.includes('startCallReconciliationJob'));
  assert.ok(billing.includes('startPaymentWebhookRetryWorker'));
});

test('billing queue respects api-ws role and zero concurrency', () => {
  const queue = readFileSync(join(root, 'modules/billing/billing.queue.ts'), 'utf8');
  assert.ok(queue.includes('shouldStartBillingBullWorker'));
  assert.ok(queue.includes('runsBillingWorkers'));
  assert.ok(queue.includes('if (raw <= 0)'));
  assert.ok(queue.includes('return 0'));
});

test('billing-worker uses headless Socket.IO for cross-node emits', () => {
  const workerHealth = readFileSync(join(root, 'bootstrap/bootstrap-worker-health.ts'), 'utf8');
  const socket = readFileSync(join(root, 'bootstrap/bootstrap-socket.ts'), 'utf8');
  assert.ok(workerHealth.includes('headlessSocket'));
  assert.ok(socket.includes('initializeHeadlessSocketIo'));
  assert.ok(socket.includes('allowRequest'));
});
