/**
 * Contract tests for POST /metrics/video-playback.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { postVideoPlaybackMetricsHandler } from '../video-playback-metrics.controller';

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

test('POST /metrics/video-playback accepts valid samples', async () => {
  const { res, captured } = mockRes();
  await postVideoPlaybackMetricsHandler(
    mockReq({
      samples: [
        { event: 'startup', context: 'reels', valueMs: 900, weight: 10 },
        {
          event: 'completion',
          context: 'story',
          valueMs: 0,
          weight: 10,
          completed: true,
          watchedPct: 95,
        },
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

test('POST /metrics/video-playback returns 400 for empty samples', async () => {
  const { res, captured } = mockRes();
  await postVideoPlaybackMetricsHandler(mockReq({ samples: [] }), res);
  assert.equal(captured.statusCode, 400);
});

test('POST /metrics/video-playback drops malformed samples', async () => {
  const { res, captured } = mockRes();
  await postVideoPlaybackMetricsHandler(
    mockReq({
      samples: [
        { event: 'startup', context: 'reels', valueMs: 100, weight: 10 },
        { event: 'INVALID EVENT', context: 'reels', valueMs: 100, weight: 10 },
        { event: 'token_refresh_fail', context: 'reels', valueMs: 0, weight: 10, httpStatus: 503 },
      ],
    }),
    res,
  );
  assert.equal(captured.statusCode, 202);
  const body = captured.body as { accepted: number; rejected: number };
  assert.equal(body.accepted, 2);
  assert.equal(body.rejected, 1);
});
