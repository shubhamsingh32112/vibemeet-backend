import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getServiceRole,
  resetServiceRoleCacheForTests,
  runsBillingWorkers,
  runsHttpApi,
  runsMomentsWorkers,
  runsImageWorkers,
  isApiWsRole,
} from '../config/service-role';

const ENV_KEYS = [
  'ECS_SERVICE_ROLE',
  'RUN_BACKGROUND_WORKERS',
  'ECS_CONTAINER_METADATA_URI',
  'ECS_CONTAINER_METADATA_URI_V4',
  'BILLING_BULLMQ_CONCURRENCY',
  'NODE_ENV',
] as const;

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetServiceRoleCacheForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  resetServiceRoleCacheForTests();
});

test('defaults to monolith when ECS_SERVICE_ROLE is unset', () => {
  assert.equal(getServiceRole(), 'monolith');
  assert.equal(runsHttpApi(), true);
  assert.equal(runsBillingWorkers(), true);
  assert.equal(runsMomentsWorkers(), true);
  assert.equal(runsImageWorkers(), true);
});

test('api-ws role disables background worker tiers', () => {
  process.env.ECS_SERVICE_ROLE = 'api-ws';
  resetServiceRoleCacheForTests();
  assert.equal(getServiceRole(), 'api-ws');
  assert.equal(isApiWsRole(), true);
  assert.equal(runsHttpApi(), true);
  assert.equal(runsBillingWorkers(), false);
  assert.equal(runsMomentsWorkers(), false);
  assert.equal(runsImageWorkers(), false);
});

test('billing-worker role enables billing only', () => {
  process.env.ECS_SERVICE_ROLE = 'billing-worker';
  resetServiceRoleCacheForTests();
  assert.equal(getServiceRole(), 'billing-worker');
  assert.equal(runsHttpApi(), false);
  assert.equal(runsBillingWorkers(), true);
  assert.equal(runsMomentsWorkers(), false);
  assert.equal(runsImageWorkers(), false);
});

test('moments-worker and image-worker roles are isolated', () => {
  process.env.ECS_SERVICE_ROLE = 'moments-worker';
  resetServiceRoleCacheForTests();
  assert.equal(runsMomentsWorkers(), true);
  assert.equal(runsBillingWorkers(), false);

  process.env.ECS_SERVICE_ROLE = 'image-worker';
  resetServiceRoleCacheForTests();
  assert.equal(runsImageWorkers(), true);
  assert.equal(runsBillingWorkers(), false);
});

test('rejects unknown ECS_SERVICE_ROLE', () => {
  process.env.ECS_SERVICE_ROLE = 'unknown-tier';
  resetServiceRoleCacheForTests();
  assert.throws(() => getServiceRole(), /Invalid ECS_SERVICE_ROLE/);
});

test('requires explicit role on ECS tasks in production', () => {
  process.env.NODE_ENV = 'production';
  process.env.ECS_CONTAINER_METADATA_URI = 'http://169.254.170.2/v2/abc';
  resetServiceRoleCacheForTests();
  assert.throws(() => getServiceRole(), /ECS task detected/);
  process.env.NODE_ENV = 'test';
});

test('BILLING_BULLMQ_CONCURRENCY=0 is documented in billing queue gating', () => {
  process.env.BILLING_BULLMQ_CONCURRENCY = '0';
  resetServiceRoleCacheForTests();
  assert.equal(getServiceRole(), 'monolith');
});
