import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getServiceRole,
  readServiceRoleEnv,
  resetServiceRoleCacheForTests,
  runsBillingWorkers,
  runsHttpApi,
  runsMomentsWorkers,
  runsImageWorkers,
  isApiWsRole,
} from '../config/service-role';

const ENV_KEYS = [
  'SERVICE_ROLE',
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

test('defaults to monolith when SERVICE_ROLE is unset in non-production', () => {
  assert.equal(getServiceRole(), 'monolith');
  assert.equal(runsHttpApi(), true);
  assert.equal(runsBillingWorkers(), true);
  assert.equal(runsMomentsWorkers(), true);
  assert.equal(runsImageWorkers(), true);
});

test('SERVICE_ROLE=api-ws disables background worker tiers', () => {
  process.env.SERVICE_ROLE = 'api-ws';
  resetServiceRoleCacheForTests();
  assert.equal(getServiceRole(), 'api-ws');
  assert.equal(isApiWsRole(), true);
  assert.equal(runsHttpApi(), true);
  assert.equal(runsBillingWorkers(), false);
  assert.equal(runsMomentsWorkers(), false);
  assert.equal(runsImageWorkers(), false);
});

test('ECS_SERVICE_ROLE remains supported as legacy alias', () => {
  process.env.ECS_SERVICE_ROLE = 'billing-worker';
  resetServiceRoleCacheForTests();
  assert.equal(readServiceRoleEnv(), 'billing-worker');
  assert.equal(getServiceRole(), 'billing-worker');
  assert.equal(runsHttpApi(), false);
  assert.equal(runsBillingWorkers(), true);
});

test('SERVICE_ROLE takes precedence over ECS_SERVICE_ROLE when equal', () => {
  process.env.SERVICE_ROLE = 'api-ws';
  process.env.ECS_SERVICE_ROLE = 'api-ws';
  resetServiceRoleCacheForTests();
  assert.equal(getServiceRole(), 'api-ws');
});

test('rejects conflicting SERVICE_ROLE and ECS_SERVICE_ROLE', () => {
  process.env.SERVICE_ROLE = 'api-ws';
  process.env.ECS_SERVICE_ROLE = 'billing-worker';
  resetServiceRoleCacheForTests();
  assert.throws(() => getServiceRole(), /Conflicting config/);
});

test('billing-worker role enables billing only', () => {
  process.env.SERVICE_ROLE = 'billing-worker';
  resetServiceRoleCacheForTests();
  assert.equal(getServiceRole(), 'billing-worker');
  assert.equal(runsHttpApi(), false);
  assert.equal(runsBillingWorkers(), true);
  assert.equal(runsMomentsWorkers(), false);
  assert.equal(runsImageWorkers(), false);
});

test('moments-worker and image-worker roles are isolated', () => {
  process.env.SERVICE_ROLE = 'moments-worker';
  resetServiceRoleCacheForTests();
  assert.equal(runsMomentsWorkers(), true);
  assert.equal(runsBillingWorkers(), false);

  process.env.SERVICE_ROLE = 'image-worker';
  resetServiceRoleCacheForTests();
  assert.equal(runsImageWorkers(), true);
  assert.equal(runsBillingWorkers(), false);
});

test('rejects unknown SERVICE_ROLE', () => {
  process.env.SERVICE_ROLE = 'unknown-tier';
  resetServiceRoleCacheForTests();
  assert.throws(() => getServiceRole(), /Invalid SERVICE_ROLE/);
});

test('requires SERVICE_ROLE in production', () => {
  process.env.NODE_ENV = 'production';
  resetServiceRoleCacheForTests();
  assert.throws(() => getServiceRole(), /SERVICE_ROLE is required in production/);
  process.env.NODE_ENV = 'test';
});

test('requires split role on ECS tasks in production', () => {
  process.env.NODE_ENV = 'production';
  process.env.ECS_CONTAINER_METADATA_URI = 'http://169.254.170.2/v2/abc';
  process.env.SERVICE_ROLE = 'monolith';
  resetServiceRoleCacheForTests();
  assert.throws(() => getServiceRole(), /not allowed on ECS/);
  process.env.NODE_ENV = 'test';
});

test('allows explicit monolith in production off ECS', () => {
  process.env.NODE_ENV = 'production';
  process.env.SERVICE_ROLE = 'monolith';
  resetServiceRoleCacheForTests();
  assert.equal(getServiceRole(), 'monolith');
  assert.equal(runsBillingWorkers(), true);
  process.env.NODE_ENV = 'test';
});

test('BILLING_BULLMQ_CONCURRENCY=0 is documented in billing queue gating', () => {
  process.env.BILLING_BULLMQ_CONCURRENCY = '0';
  resetServiceRoleCacheForTests();
  assert.equal(getServiceRole(), 'monolith');
});
