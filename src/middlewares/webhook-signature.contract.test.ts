import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import {
  verifyRazorpayWebhookSignature,
  verifyStreamChatWebhookSignature,
} from './webhook-signature.middleware';

function createMockResponse() {
  const state: { statusCode?: number; payload?: any } = {};
  const res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(payload: any) {
      state.payload = payload;
      return this;
    },
  } as unknown as Response;
  return { res, state };
}

test('chat webhook rejects missing signature by default in non-production', () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevAllowInsecure = process.env.ALLOW_INSECURE_WEBHOOKS;
  process.env.NODE_ENV = 'development';
  delete process.env.ALLOW_INSECURE_WEBHOOKS;

  let nextCalled = false;
  const req = {
    headers: {},
    path: '/api/v1/chat/webhook',
    body: Buffer.from('{}'),
  } as unknown as Request;
  const { res, state } = createMockResponse();

  verifyStreamChatWebhookSignature(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 401);

  process.env.NODE_ENV = prevNodeEnv;
  process.env.ALLOW_INSECURE_WEBHOOKS = prevAllowInsecure;
});

test('chat webhook allows missing signature only with explicit override', () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevAllowInsecure = process.env.ALLOW_INSECURE_WEBHOOKS;
  process.env.NODE_ENV = 'development';
  process.env.ALLOW_INSECURE_WEBHOOKS = 'true';

  let nextCalled = false;
  const req = {
    headers: {},
    path: '/api/v1/chat/webhook',
    body: Buffer.from('{}'),
  } as unknown as Request;
  const { res } = createMockResponse();

  verifyStreamChatWebhookSignature(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);

  process.env.NODE_ENV = prevNodeEnv;
  process.env.ALLOW_INSECURE_WEBHOOKS = prevAllowInsecure;
});

test('razorpay webhook rejects request without signature', () => {
  const prevSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = 'test-secret';

  let nextCalled = false;
  const req = {
    headers: {},
    path: '/api/v1/payment/webhook',
    body: Buffer.from('{"event":"payment.captured"}'),
  } as unknown as Request;
  const { res, state } = createMockResponse();

  verifyRazorpayWebhookSignature(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 401);

  process.env.RAZORPAY_WEBHOOK_SECRET = prevSecret;
});

