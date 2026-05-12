/**
 * Contract tests for POST /metrics/image-render.
 *
 * Verifies:
 *   - Valid samples → 202 { success:true, accepted, rejected:0 }
 *   - Empty/missing body → 400 INVALID_SAMPLES
 *   - Oversize batch → 413 TOO_MANY_SAMPLES
 *   - Per-sample validation drops bad rows without 4xx
 *   - Variant pattern enforced
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { postImageRenderMetricsHandler } from '../image-render-metrics.controller';

interface CapturedResponse {
  statusCode: number;
  body: unknown;
}

function mockRes(): { res: Response; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 0, body: undefined };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, captured };
}

function mockReq(body: unknown): Request {
  return { body } as unknown as Request;
}

test('POST /metrics/image-render accepts a valid batch and returns 202', async () => {
  const { res, captured } = mockRes();
  await postImageRenderMetricsHandler(
    mockReq({
      samples: [
        { variant: 'avatarMd', latencyMs: 120, decoded: true, weight: 10 },
        { variant: 'galleryThumb', latencyMs: 80, decoded: false, weight: 5 },
      ],
    }),
    res,
  );
  assert.equal(captured.statusCode, 202);
  const body = captured.body as { success: boolean; accepted: number; rejected: number };
  assert.equal(body.success, true);
  assert.equal(body.accepted, 2);
  assert.equal(body.rejected, 0);
});

test('POST /metrics/image-render returns 400 when samples is missing/empty', async () => {
  for (const body of [{}, { samples: [] }, { samples: null }]) {
    const { res, captured } = mockRes();
    await postImageRenderMetricsHandler(mockReq(body), res);
    assert.equal(captured.statusCode, 400, `body=${JSON.stringify(body)} should 400`);
    const out = captured.body as { code: string };
    assert.equal(out.code, 'INVALID_SAMPLES');
  }
});

test('POST /metrics/image-render returns 413 when over MAX_SAMPLES_PER_BATCH', async () => {
  const samples = Array.from({ length: 51 }, () => ({
    variant: 'avatarMd',
    latencyMs: 100,
    decoded: true,
    weight: 1,
  }));
  const { res, captured } = mockRes();
  await postImageRenderMetricsHandler(mockReq({ samples }), res);
  assert.equal(captured.statusCode, 413);
  assert.equal((captured.body as { code: string }).code, 'TOO_MANY_SAMPLES');
});

test('POST /metrics/image-render drops malformed samples without 4xx', async () => {
  const { res, captured } = mockRes();
  await postImageRenderMetricsHandler(
    mockReq({
      samples: [
        { variant: 'avatarMd', latencyMs: 100, decoded: true, weight: 1 },  // valid
        { variant: 'BAD VARIANT', latencyMs: 100, decoded: true, weight: 1 }, // bad variant
        { variant: 'avatarMd', latencyMs: 999999, decoded: true, weight: 1 }, // out-of-range latency
        { variant: 'avatarMd', latencyMs: 100, decoded: 'yes', weight: 1 }, // wrong type
        { variant: 'avatarMd', latencyMs: 100, decoded: true, weight: 0 }, // weight below 1
      ],
    }),
    res,
  );
  assert.equal(captured.statusCode, 202);
  const body = captured.body as { accepted: number; rejected: number };
  assert.equal(body.accepted, 1);
  assert.equal(body.rejected, 4);
});

test('POST /metrics/image-render rejects negative latency', async () => {
  const { res, captured } = mockRes();
  await postImageRenderMetricsHandler(
    mockReq({
      samples: [{ variant: 'avatarMd', latencyMs: -5, decoded: true, weight: 1 }],
    }),
    res,
  );
  assert.equal(captured.statusCode, 202);
  assert.equal((captured.body as { accepted: number }).accepted, 0);
  assert.equal((captured.body as { rejected: number }).rejected, 1);
});

test('POST /metrics/image-render accepts all canonical Cloudflare variant names', async () => {
  const variants = [
    'avatarXs',
    'avatarSm',
    'avatarMd',
    'feedTile',
    'callPhoto',
    'callBg',
    'galleryThumb',
    'galleryMd',
    'galleryXl',
  ];
  const samples = variants.map((variant) => ({
    variant,
    latencyMs: 50,
    decoded: true,
    weight: 1,
  }));
  const { res, captured } = mockRes();
  await postImageRenderMetricsHandler(mockReq({ samples }), res);
  assert.equal(captured.statusCode, 202);
  assert.equal((captured.body as { accepted: number }).accepted, variants.length);
});
