/**
 * Ensures the Stream webhook route wires only the modern handler (no legacy in-memory billing).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('video routes must not import legacy webhook billing', () => {
  const p = join(__dirname, 'video.routes.ts');
  const src = readFileSync(p, 'utf8');
  assert.ok(!src.includes('legacy.webhook'), 'legacy webhook must not be imported');
  assert.ok(
    src.includes("from './video.webhook'") || src.includes('from "./video.webhook"'),
    'expected handleStreamVideoWebhook from video.webhook'
  );
  assert.ok(src.includes('handleStreamVideoWebhook'));
});
