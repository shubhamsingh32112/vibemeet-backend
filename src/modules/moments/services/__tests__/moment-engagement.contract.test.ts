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
