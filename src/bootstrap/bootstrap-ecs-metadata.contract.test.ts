import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('ECS metadata resolver reads task ARN and sets BILLING_INSTANCE_ID fallback', () => {
  const src = readFileSync(join(__dirname, 'bootstrap-ecs-metadata.ts'), 'utf8');
  assert.ok(src.includes('ECS_CONTAINER_METADATA_URI_V4'));
  assert.ok(src.includes('/task'));
  assert.ok(src.includes('BILLING_INSTANCE_ID'));
  assert.ok(src.includes('parseTaskIdFromArn'));
});

test('load-env invokes ECS billing instance resolver', () => {
  const src = readFileSync(join(__dirname, 'load-env.ts'), 'utf8');
  assert.ok(src.includes('resolveBillingInstanceIdFromEcs'));
});
