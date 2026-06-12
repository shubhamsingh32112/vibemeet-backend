import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPublicAppConfig } from './app-config.service';

test('getPublicAppConfig exposes feature and pricing fields', () => {
  const config = getPublicAppConfig();
  assert.equal(typeof config.features.vipEnabled, 'boolean');
  assert.equal(typeof config.features.momentsEnabled, 'boolean');
  assert.equal(typeof config.pricing.welcomeIntroCallCredits, 'number');
  assert.equal(typeof config.pricing.minCoinsToCall, 'number');
  assert.ok(config.pricing.welcomeIntroCallCredits >= 0);
  assert.ok(config.pricing.minCoinsToCall >= 0);
});

test('app-config route is mounted without auth middleware', () => {
  const routesSrc = readFileSync(join(__dirname, 'app-config.routes.ts'), 'utf8');
  assert.ok(routesSrc.includes("router.get('/', getAppConfig)"));
  assert.ok(!routesSrc.includes('verifyFirebaseToken'));
});

test('app-config controller returns success wrapper', () => {
  const src = readFileSync(join(__dirname, 'app-config.controller.ts'), 'utf8');
  assert.ok(src.includes('getPublicAppConfig()'));
  assert.ok(src.includes('success: true'));
});
