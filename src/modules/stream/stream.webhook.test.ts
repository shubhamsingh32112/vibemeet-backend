import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Request } from 'express';
import { verifyStreamWebhook } from './stream.webhook';
import { __resetCloudflareStreamConfigForTests } from '../../config/cloudflare-stream';

test('verifyStreamWebhook accepts Cloudflare Webhook-Signature format', () => {
  const prev = {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_STREAM_API_TOKEN,
    customerCode: process.env.CLOUDFLARE_STREAM_CUSTOMER_CODE,
    webhookSecret: process.env.CLOUDFLARE_STREAM_WEBHOOK_SECRET,
  };

  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct';
  process.env.CLOUDFLARE_STREAM_API_TOKEN = 'token';
  process.env.CLOUDFLARE_STREAM_CUSTOMER_CODE = 'code';
  process.env.CLOUDFLARE_STREAM_WEBHOOK_SECRET = '85011ed3a913c6ad5f9cf6c5573cc0a7';
  __resetCloudflareStreamConfigForTests();

  const rawBody = '{"uid":"abc","status":{"state":"ready"}}';
  const time = String(Math.floor(Date.now() / 1000));
  const sig1 = crypto
    .createHmac('sha256', process.env.CLOUDFLARE_STREAM_WEBHOOK_SECRET!)
    .update(`${time}.${rawBody}`)
    .digest('hex');

  const req = {
    headers: {
      'webhook-signature': `time=${time},sig1=${sig1}`,
    },
    body: JSON.parse(rawBody),
    rawBody,
  } as unknown as Request;

  assert.equal(verifyStreamWebhook(req), true);

  process.env.CLOUDFLARE_ACCOUNT_ID = prev.accountId;
  process.env.CLOUDFLARE_STREAM_API_TOKEN = prev.apiToken;
  process.env.CLOUDFLARE_STREAM_CUSTOMER_CODE = prev.customerCode;
  process.env.CLOUDFLARE_STREAM_WEBHOOK_SECRET = prev.webhookSecret;
  __resetCloudflareStreamConfigForTests();
});
