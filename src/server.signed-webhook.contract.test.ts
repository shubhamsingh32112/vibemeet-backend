import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const serverPath = join(__dirname, 'server.ts');

test('isSignedWebhookPost includes all Razorpay and Stream signed webhook paths', () => {
  const src = readFileSync(serverPath, 'utf8');
  const signedPaths = [
    '/api/v1/video/webhook',
    '/api/v1/chat/webhook',
    '/api/v1/payment/webhook',
    '/api/v1/stream/webhook',
    '/api/v1/vip/webhook',
  ];
  for (const path of signedPaths) {
    assert.ok(
      src.includes(`'${path}'`) || src.includes(`"${path}"`),
      `expected ${path} in isSignedWebhookPost`
    );
  }
});

test('signed webhook middleware skips json parser for raw body verification', () => {
  const src = readFileSync(serverPath, 'utf8');
  assert.ok(src.includes('express.raw'), 'raw parser required for signed webhooks');
  assert.ok(
    src.includes('isSignedWebhookPost(req)'),
    'signed webhook guard must gate body parsers'
  );
});
