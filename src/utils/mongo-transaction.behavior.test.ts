import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyFailureStage,
  isTransientMongoTransactionError,
  isUnknownCommitResult,
} from './mongo-transaction';

test('classifyFailureStage: commit stage on UnknownTransactionCommitResult', () => {
  const err = { errorLabels: ['UnknownTransactionCommitResult'] };
  assert.equal(classifyFailureStage(err, 'commit'), 'commit');
});

test('classifyFailureStage: during_write on debit stage', () => {
  const err = { code: 112, errorLabels: ['TransientTransactionError'] };
  assert.equal(classifyFailureStage(err, 'debit_user_wallet'), 'during_write');
});

test('classifyFailureStage: before_write on read_user', () => {
  const err = new Error('User not found');
  assert.equal(classifyFailureStage(err, 'read_user'), 'before_write');
});

test('isTransientMongoTransactionError detects WriteConflict code 112', () => {
  assert.equal(isTransientMongoTransactionError({ code: 112 }), true);
});

test('isUnknownCommitResult detects label', () => {
  assert.equal(isUnknownCommitResult({ errorLabels: ['UnknownTransactionCommitResult'] }), true);
  assert.equal(isUnknownCommitResult({ code: 112 }), false);
});
