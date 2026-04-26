import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('user routes expose onboarding permissions decision endpoint', () => {
  const src = readFileSync(join(__dirname, 'user.routes.ts'), 'utf8');
  assert.ok(src.includes("'/onboarding/permissions-decision'"));
  assert.ok(src.includes('submitOnboardingPermissionsDecision'));
});

test('permissions decision handler uses request id idempotency guard', () => {
  const src = readFileSync(join(__dirname, 'user.controller.ts'), 'utf8');
  assert.ok(src.includes('submitPermissionsDecisionEvent'));
  assert.ok(src.includes('idempotentReplay: transition.idempotentReplay'));
  assert.ok(src.includes('permission_decision decision='));
});

test('onboarding stage handler uses transition service and strict invalid code', () => {
  const src = readFileSync(join(__dirname, 'user.controller.ts'), 'utf8');
  assert.ok(src.includes('applyOnboardingStageEvent'));
  assert.ok(src.includes('INVALID_ONBOARDING_TRANSITION'));
  assert.ok(src.includes('status(409)'));
  assert.ok(src.includes("req.headers['x-idempotency-key']"));
  assert.ok(src.includes('invalid_transition_rate'));
  assert.ok(src.includes('atomic_conflict_replay_rate'));
});

test('onboarding payload includes permission onboarding outcome', () => {
  const src = readFileSync(join(__dirname, 'user.controller.ts'), 'utf8');
  assert.ok(src.includes('permissionOnboardingStatus'));
});
