import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompletionUpdate,
  canonicalizeStage,
  isAllowedTransition,
  mayRolloutFastForward,
  resolveEffectiveFlowVersion,
  semverLt,
  toNextStageFromEvent,
} from './onboarding-transition.service';
import type { IUser } from './user.model';

test('canonicalizeStage keeps permissions canonical', () => {
  assert.equal(canonicalizeStage('permission'), 'permissions');
  assert.equal(canonicalizeStage('permissions'), 'permissions');
  assert.equal(canonicalizeStage('bonus'), 'bonus');
});

test('v1 transition map is strict linear forward-only', () => {
  assert.equal(isAllowedTransition('welcome', 'bonus', 1), true);
  assert.equal(isAllowedTransition('bonus', 'permissions', 1), true);
  assert.equal(isAllowedTransition('permissions', 'completed', 1), true);
  assert.equal(isAllowedTransition('welcome', 'completed', 1), false);
  assert.equal(isAllowedTransition('completed', 'welcome', 1), false);
});

test('v2 transition map skips bonus in canonical path', () => {
  assert.equal(isAllowedTransition('welcome', 'permissions', 2), true);
  assert.equal(isAllowedTransition('welcome', 'bonus', 2), false);
  assert.equal(isAllowedTransition('bonus', 'permissions', 2), true);
  assert.equal(isAllowedTransition('permissions', 'completed', 2), true);
  assert.equal(isAllowedTransition('welcome', 'completed', 2), false);
});

test('v1 event mapping', () => {
  assert.equal(toNextStageFromEvent('welcome_seen', 1), 'bonus');
  assert.equal(toNextStageFromEvent('bonus_seen', 1), 'permissions');
  assert.equal(toNextStageFromEvent('permissions_not_now', 1), 'permissions');
  assert.equal(toNextStageFromEvent('permissions_accept', 1), 'completed');
});

test('v2 event mapping', () => {
  assert.equal(toNextStageFromEvent('welcome_seen', 2), 'permissions');
  assert.equal(toNextStageFromEvent('bonus_seen', 2), 'permissions');
  assert.equal(toNextStageFromEvent('permissions_accept', 2), 'completed');
});

test('buildCompletionUpdate v2 welcome to permissions sets welcome timestamp', () => {
  const now = new Date();
  const doc = buildCompletionUpdate('welcome', 'permissions', now, 2);
  const set = (doc as { $set: Record<string, unknown> }).$set;
  assert.equal(set.onboardingStage, 'permissions');
  assert.ok(set.onboardingWelcomeSeenAt instanceof Date);
  assert.equal(set.onboardingBonusSeenAt, undefined);
});

test('resolveEffectiveFlowVersion never downgrades user', () => {
  assert.equal(resolveEffectiveFlowVersion(2, 1), 2);
  assert.equal(resolveEffectiveFlowVersion(1, 2), 2);
  assert.equal(resolveEffectiveFlowVersion(1, 1), 1);
});

test('semverLt compares dotted versions', () => {
  assert.equal(semverLt('1.0.0', '2.0.0'), true);
  assert.equal(semverLt('2.1.0', '2.0.9'), false);
});

test('mayRolloutFastForward requires deadline and guard', () => {
  const prevUntil = process.env.ONBOARDING_FAST_FORWARD_UNTIL;
  const prevMin = process.env.MIN_FIXED_CLIENT_VERSION;
  process.env.ONBOARDING_FAST_FORWARD_UNTIL = '2099-12-31T00:00:00.000Z';
  process.env.MIN_FIXED_CLIENT_VERSION = '99.0.0';

  const baseUser = {
    onboardingPermissionSeenAt: null,
  } as IUser;

  assert.equal(
    mayRolloutFastForward({
      event: 'permissions_accept',
      fromStage: 'bonus',
      user: baseUser,
      clientAppVersion: '1.0.0',
    }).allowed,
    true
  );

  assert.equal(
    mayRolloutFastForward({
      event: 'permissions_accept',
      fromStage: 'permissions',
      user: baseUser,
    }).allowed,
    false
  );

  const seenUser = {
    onboardingPermissionSeenAt: new Date(),
  } as IUser;
  assert.equal(
    mayRolloutFastForward({
      event: 'permissions_accept',
      fromStage: 'welcome',
      user: seenUser,
    }).guard,
    'permission_seen_at'
  );

  process.env.ONBOARDING_FAST_FORWARD_UNTIL = prevUntil ?? '';
  process.env.MIN_FIXED_CLIENT_VERSION = prevMin ?? '';
});

test('mayRolloutFastForward disabled after deadline', () => {
  const prevUntil = process.env.ONBOARDING_FAST_FORWARD_UNTIL;
  process.env.ONBOARDING_FAST_FORWARD_UNTIL = '2000-01-01T00:00:00.000Z';

  const user = { onboardingPermissionSeenAt: new Date() } as IUser;
  assert.equal(
    mayRolloutFastForward({
      event: 'permissions_accept',
      fromStage: 'welcome',
      user,
      now: new Date('2026-01-01'),
    }).allowed,
    false
  );

  process.env.ONBOARDING_FAST_FORWARD_UNTIL = prevUntil ?? '';
});
