import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('availability service exposes creator base presence helpers', () => {
  const src = readFileSync(join(__dirname, 'availability.service.ts'), 'utf8');
  assert.ok(src.includes('setCreatorBaseAvailability'));
  assert.ok(src.includes('refreshCreatorBaseAvailability'));
  assert.ok(src.includes('creator_base_availability_set_failed'));
});

test('legacy availability socket path is hard-disabled', () => {
  const src = readFileSync(join(__dirname, 'availability.socket.ts'), 'utf8');
  assert.ok(
    src.includes('ENABLE_LEGACY_AVAILABILITY_SOCKET=true is not supported'),
    'legacy socket enable path must throw'
  );
  assert.ok(src.includes('emitCreatorStatus is disabled'));
});

test('gateway disconnect fallback uses transition, not direct creator emits', () => {
  const src = readFileSync(join(__dirname, 'availability.gateway.ts'), 'utf8');
  assert.ok(src.includes('availability.gateway.disconnect_last_socket'));
  assert.ok(!src.includes("io.to('consumors').emit('creator:status', payload)"));
});

test('presence service broadcasts creator:status on CONNECTED', () => {
  const src = readFileSync(join(__dirname, 'presence.service.ts'), 'utf8');
  assert.ok(src.includes("eventType === 'CONNECTED'"));
});

test('presence service keeps user-model shadow compare diagnostics', () => {
  const src = readFileSync(join(__dirname, 'presence.service.ts'), 'utf8');
  assert.ok(src.includes('creatorPresenceUserModelShadowCompareEnabled'));
  assert.ok(src.includes('creator_presence_user_model_shadow_mismatch'));
});

test('presence service dual-writes canonical creator presence payload', () => {
  const src = readFileSync(join(__dirname, 'presence.service.ts'), 'utf8');
  assert.ok(src.includes('creatorPresenceKey(firebaseUid)'));
  assert.ok(src.includes('state: nextRecord.state'));
  assert.ok(src.includes('version: nextRecord.version'));
});

test('batch presence records canonical-missing and fallback rates', () => {
  const src = readFileSync(join(__dirname, 'presence.service.ts'), 'utf8');
  assert.ok(src.includes('presence.creator_batch_canonical_missing_rate'));
  assert.ok(src.includes('presence.creator_batch_fallback_rate'));
  assert.ok(src.includes('creator_presence_batch_canonical_missing_high'));
  assert.ok(src.includes('expectedCanonicalCount'));
  assert.ok(src.includes('presence.creator_meta_missing_any_rate'));
  assert.ok(src.includes('presence.creator_meta_missing_expected_rate'));
  assert.ok(src.includes('presence.creator_expected_canonical_coverage_rate'));
  assert.ok(src.includes('presence.creator_meta_parse_failure_rate'));
  assert.ok(src.includes('presence.creator_uid_contract_violation_rate'));
  assert.ok(src.includes('presence.creator_transition_retry_count'));
});

test('uid contract rate metrics are emitted as ratios at ingress', () => {
  const gatewaySrc = readFileSync(join(__dirname, 'availability.gateway.ts'), 'utf8');
  const controllerSrc = readFileSync(join(__dirname, '../creator/creator.controller.ts'), 'utf8');
  assert.ok(gatewaySrc.includes("invalidUids.length / Math.max(totalInput, 1)"));
  assert.ok(controllerSrc.includes("invalidUids.length / Math.max(totalInput, 1)"));
});

test('gateway enforce mode only blocks when all IDs invalid', () => {
  const gatewaySrc = readFileSync(join(__dirname, 'availability.gateway.ts'), 'utf8');
  assert.ok(gatewaySrc.includes('featureFlags.creatorPresenceUidContractEnforced && firebaseUids.length === 0'));
  assert.ok(gatewaySrc.includes('availability_get_uid_contract_all_invalid_enforced'));
  assert.ok(gatewaySrc.includes("recordCallMetric('presence.creator_uid_contract_enforced_block'"));
});

