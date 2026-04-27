import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompletionUpdate,
  canonicalizeStage,
  isAllowedTransition,
  toNextStageFromEvent,
} from './onboarding-transition.service';

test('canonicalizeStage keeps permissions canonical', () => {
  assert.equal(canonicalizeStage('permission'), 'permissions');
  assert.equal(canonicalizeStage('permissions'), 'permissions');
  assert.equal(canonicalizeStage('bonus'), 'bonus');
});

test('transition map is strict linear forward-only', () => {
  assert.equal(isAllowedTransition('welcome', 'bonus'), true);
  assert.equal(isAllowedTransition('bonus', 'permissions'), true);
  assert.equal(isAllowedTransition('permissions', 'completed'), true);
  assert.equal(isAllowedTransition('welcome', 'completed'), false);
  assert.equal(isAllowedTransition('completed', 'welcome'), false);
});

test('event mapping advances to expected next stage', () => {
  assert.equal(toNextStageFromEvent('welcome_seen'), 'bonus');
  assert.equal(toNextStageFromEvent('bonus_seen'), 'permissions');
  assert.equal(toNextStageFromEvent('permissions_not_now'), 'permissions');
  assert.equal(toNextStageFromEvent('permissions_accept'), 'completed');
});

test('buildCompletionUpdate uses $set only (no ConflictingUpdateOperators)', () => {
  const now = new Date();
  const doc = buildCompletionUpdate('welcome', 'bonus', now);
  assert.ok('$set' in doc);
  assert.equal('$setOnInsert' in doc, false);
  const set = (doc as { $set: Record<string, unknown> }).$set;
  assert.equal(set.onboardingStage, 'bonus');
  assert.ok(set.onboardingWelcomeSeenAt instanceof Date);
});
