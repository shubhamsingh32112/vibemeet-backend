import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  callSessionKey,
  callSessionTerminalKey,
  isCallSessionTerminalRedisKey,
  parseCallIdFromSessionRedisKey,
  isInvalidBillingCallId,
} from '../../config/redis';

test('parseCallIdFromSessionRedisKey ignores terminal tombstone keys', () => {
  const callId = 'user_creator_1780320811';
  assert.equal(parseCallIdFromSessionRedisKey(callSessionKey(callId)), callId);
  assert.equal(parseCallIdFromSessionRedisKey(callSessionTerminalKey(callId)), null);
  assert.equal(isCallSessionTerminalRedisKey(callSessionTerminalKey(callId)), true);
});

test('tombstone-derived call ids are rejected for settlement', () => {
  assert.equal(isInvalidBillingCallId('abc:terminal'), true);
  assert.equal(isInvalidBillingCallId('abc'), false);
});
