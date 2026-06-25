import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('popular feed prepends previews only on first page (no premium branch)', () => {
  const src = readFileSync(join(__dirname, '../moments-feed.service.ts'), 'utf8');
  const start = src.indexOf('export async function buildPopularFeedOrdering');
  const end = src.indexOf('export async function buildFollowingFeedOrdering');
  const block = src.slice(start, end);
  assert.ok(block.includes('const isFirstPage = !cursor'));
  assert.ok(block.includes('if (isFirstPage)'));
  assert.ok(!block.includes('isPremium'));
});

test('following feed prepends previews only when offset is zero', () => {
  const src = readFileSync(join(__dirname, '../moments-feed.service.ts'), 'utf8');
  const start = src.indexOf('export async function buildFollowingFeedOrdering');
  const block = src.slice(start);
  assert.ok(block.includes('const isFirstPage = offset === 0'));
  assert.ok(block.includes('if (isFirstPage)'));
  assert.ok(!block.includes('isPremium'));
});
