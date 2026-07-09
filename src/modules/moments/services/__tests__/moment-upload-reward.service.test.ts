import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  __resetMomentsConfigForTests,
  getMomentsConfig,
} from '../../../../config/moments';
import {
  resolveMomentUploadRewardCoins,
  uploadRewardCreditTransactionId,
  uploadRewardClawbackTransactionId,
} from '../moment-upload-reward.service';
import {
  decodeMomentsGalleryCursor,
  encodeMomentsGalleryCursor,
} from '../../../admin/admin-moments-management.controller';

test('resolveMomentUploadRewardCoins defaults to 10 photo / 30 video', () => {
  __resetMomentsConfigForTests();
  delete process.env.MOMENTS_PHOTO_UPLOAD_REWARD_COINS;
  delete process.env.MOMENTS_VIDEO_UPLOAD_REWARD_COINS;
  getMomentsConfig();

  assert.equal(resolveMomentUploadRewardCoins('photo'), 10);
  assert.equal(resolveMomentUploadRewardCoins('video'), 30);
});

describe('upload reward transaction ids', () => {
  test('credit and clawback ids are stable per moment', () => {
    assert.equal(uploadRewardCreditTransactionId('abc123'), 'moment_upload_reward_abc123');
    assert.equal(
      uploadRewardClawbackTransactionId('abc123'),
      'moment_upload_reward_clawback_abc123',
    );
  });
});

describe('moments gallery cursor', () => {
  test('encode/decode round trip', () => {
    const createdAt = new Date('2026-07-09T10:00:00.000Z');
    const id = new mongoose.Types.ObjectId();
    const cursor = encodeMomentsGalleryCursor(createdAt, id);
    const decoded = decodeMomentsGalleryCursor(cursor);
    assert.ok(decoded);
    assert.equal(decoded!.createdAt.toISOString(), createdAt.toISOString());
    assert.equal(decoded!.id.toString(), id.toString());
  });

  test('invalid cursor returns null', () => {
    assert.equal(decodeMomentsGalleryCursor('not-a-valid-cursor'), null);
  });
});
