import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppVideoCallId } from './billing-call-id.util';
import { assertBillingRestCallStartedAccess } from './billing-rest-access';

test('parseAppVideoCallId supports current and legacy call id formats', () => {
  const current = parseAppVideoCallId('fan_uid_64f88af948f1b97d5b1f4d7a_1717171717');
  assert.ok(current);
  assert.equal(current?.initiatorFirebaseUid, 'fan_uid');
  assert.equal(current?.creatorMongoId, '64f88af948f1b97d5b1f4d7a');
  assert.equal(current?.unixSeconds, '1717171717');

  const legacy = parseAppVideoCallId('fan_uid_64f88af948f1b97d5b1f4d7a');
  assert.ok(legacy);
  assert.equal(legacy?.initiatorFirebaseUid, 'fan_uid');
  assert.equal(legacy?.creatorMongoId, '64f88af948f1b97d5b1f4d7a');
  assert.equal(legacy?.unixSeconds, undefined);
});

test('creator-origin HTTP billing start requires explicit payer and resolves correctly', () => {
  const creatorUid = 'creator_uid';
  const fanUid = 'fan_uid';
  const creatorMongoId = '64f88af948f1b97d5b1f4d7a';
  const callId = `${creatorUid}_${creatorMongoId}_1717171717`;

  const missingPayer = assertBillingRestCallStartedAccess(
    creatorUid,
    callId,
    creatorUid,
    creatorMongoId,
    null
  );
  assert.equal(missingPayer.ok, false);
  if (!missingPayer.ok) {
    assert.equal(missingPayer.status, 400);
  }

  const withPayer = assertBillingRestCallStartedAccess(
    creatorUid,
    callId,
    creatorUid,
    creatorMongoId,
    fanUid
  );
  assert.equal(withPayer.ok, true);
  if (withPayer.ok) {
    assert.equal(withPayer.payerFirebaseUid, fanUid);
  }
});
