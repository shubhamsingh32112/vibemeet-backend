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
  assert.ok(src.includes('lastPermissionsDecisionRequestId'));
  assert.ok(src.includes('idempotentReplay: true'));
  assert.ok(src.includes('permission_decision decision='));
});
