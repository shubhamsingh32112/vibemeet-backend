import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetMomentsConfigForTests,
  getMomentsConfig,
} from '../../../../config/moments';
import { resolveMomentUploadRewardCoins } from '../moment-upload-reward.service';

test('resolveMomentUploadRewardCoins defaults to 10 photo / 30 video', () => {
  __resetMomentsConfigForTests();
  delete process.env.MOMENTS_PHOTO_UPLOAD_REWARD_COINS;
  delete process.env.MOMENTS_VIDEO_UPLOAD_REWARD_COINS;
  getMomentsConfig();

  assert.equal(resolveMomentUploadRewardCoins('photo'), 10);
  assert.equal(resolveMomentUploadRewardCoins('video'), 30);
});
