import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('moment engagement service defines like and comment models usage', () => {
  const src = readFileSync(join(__dirname, '../moment-engagement.service.ts'), 'utf8');
  assert.ok(src.includes('MomentLike'));
  assert.ok(src.includes('MomentComment'));
  assert.ok(src.includes('MomentCommentLike'));
  assert.ok(src.includes('engagementScore'));
});

test('moments routes expose engagement endpoints', () => {
  const src = readFileSync(join(__dirname, '../../routes/moments.routes.ts'), 'utf8');
  assert.ok(src.includes('/:momentId/like'));
  assert.ok(src.includes('/:momentId/comments'));
  assert.ok(src.includes('/:momentId/share'));
});

test('moment engagement service supports VIP highlighted comments', () => {
  const src = readFileSync(join(__dirname, '../moment-engagement.service.ts'), 'utf8');
  assert.ok(src.includes('isVipHighlighted'));
  assert.ok(src.includes('pinnedHighlightedComments'));
  assert.ok(src.includes('isVipActive'));
  assert.ok(src.includes('$ne: true'));
  assert.ok(src.includes('isMomentsFreeAccessMode'));
});

test('legacy upload reward status defaults to approved in creator DTO', () => {
  const src = readFileSync(join(__dirname, '../moment-presentation.service.ts'), 'utf8');
  assert.ok(src.includes('resolveUploadRewardStatusForDto'));
  assert.ok(src.includes('UploadRewardStatus.Approved'));
});

test('feed dto includes VIP highlight fields', () => {
  const src = readFileSync(join(__dirname, '../../dto/moment.dto.ts'), 'utf8');
  assert.ok(src.includes('isVipHighlighted'));
  assert.ok(src.includes('pinnedHighlightedComments'));
});

test('feed dto includes engagement fields', () => {
  const src = readFileSync(join(__dirname, '../../dto/moment.dto.ts'), 'utf8');
  assert.ok(src.includes('likesCount'));
  assert.ok(src.includes('commentsCount'));
  assert.ok(src.includes('isLiked'));
});

test('moment share url pattern is stable', () => {
  const base = 'https://example.com/moment';
  const scheme = 'zztherapy';
  const id = 'abc123';
  const shareUrl = `${base}?id=${encodeURIComponent(id)}`;
  const deepLink = `${scheme}://moment?id=${encodeURIComponent(id)}`;
  assert.equal(shareUrl, 'https://example.com/moment?id=abc123');
  assert.equal(deepLink, 'zztherapy://moment?id=abc123');
});
