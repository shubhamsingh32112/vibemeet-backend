/**
 * HTTP-contract snapshot tests for the /images/* surface.
 *
 * We invoke the controllers directly with a minimal req/res mock so we can
 * lock the JSON wire shape (status code, body keys, header set) without
 * standing up the full Express stack. Snapshots target the contracts that
 * the Flutter client depends on:
 *   - GET  /images/health             (healthy + disabled response shape)
 *   - GET  /images/presets            (empty manifest shape)
 *   - POST /images/direct-upload      (validation error shapes, no network)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

// Test config — deterministic Cloudflare wiring so URL host invariants stand.
process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account-id';
process.env.CLOUDFLARE_ACCOUNT_HASH = 'test-account-hash-1234567890abcdef';
process.env.CLOUDFLARE_IMAGES_API_TOKEN = 'test-api-token';
process.env.CLOUDFLARE_IMAGES_DELIVERY_HOST = 'imagedelivery.net';

import { __resetCloudflareConfigForTests } from '../../../config/cloudflare';
import {
  getImagesHealthHandler,
  getPresetAvatarsHandler,
  createDirectUploadHandler,
} from '../images.controller';

__resetCloudflareConfigForTests();

// ── Mock req/res helpers ────────────────────────────────────────────────
interface CapturedResponse {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
}

function mockRes(): { res: Response; captured: CapturedResponse } {
  const captured: CapturedResponse = {
    statusCode: 0,
    body: undefined,
    headers: {},
  };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
    setHeader(name: string, value: string | number) {
      captured.headers[name.toLowerCase()] = String(value);
      return this;
    },
    getHeader(name: string) {
      return captured.headers[name.toLowerCase()];
    },
  } as unknown as Response;
  return { res, captured };
}

function mockReq(body: Record<string, unknown> = {}, auth?: { firebaseUid?: string }): Request {
  return {
    body,
    auth,
    headers: {},
  } as unknown as Request;
}

// ── GET /images/health ──────────────────────────────────────────────────
test('GET /images/health (enabled) returns 200 + { success, enabled, timestamp }', async () => {
  process.env.USE_CLOUDFLARE_IMAGES = 'true';
  const { res, captured } = mockRes();
  await getImagesHealthHandler(mockReq(), res);
  assert.equal(captured.statusCode, 200);
  const body = captured.body as { success: boolean; enabled: boolean; timestamp: string };
  assert.equal(body.success, true);
  assert.equal(body.enabled, true);
  assert.equal(typeof body.timestamp, 'string');
  assert.ok(
    !Number.isNaN(Date.parse(body.timestamp)),
    'timestamp must be a parseable ISO string',
  );
  assert.deepEqual(Object.keys(body).sort(), ['enabled', 'success', 'timestamp']);
});

test('GET /images/health (disabled flag) returns 503 + { success:false, enabled:false }', async () => {
  process.env.USE_CLOUDFLARE_IMAGES = 'false';
  const { res, captured } = mockRes();
  await getImagesHealthHandler(mockReq(), res);
  assert.equal(captured.statusCode, 503);
  const body = captured.body as { success: boolean; enabled: boolean; timestamp: string };
  assert.equal(body.success, false);
  assert.equal(body.enabled, false);
  assert.equal(typeof body.timestamp, 'string');
});

// ── GET /images/presets ─────────────────────────────────────────────────
test('GET /images/presets (enabled, empty manifest) returns { success, data:{ male, female, default } }', async () => {
  process.env.USE_CLOUDFLARE_IMAGES = 'true';
  const { res, captured } = mockRes();
  await getPresetAvatarsHandler(mockReq(), res);
  assert.equal(captured.statusCode, 200);
  const body = captured.body as { success: boolean; data: unknown };
  assert.equal(body.success, true);
  const data = body.data as { male: unknown[]; female: unknown[]; default: unknown };
  assert.ok(Array.isArray(data.male), 'male must be an array');
  assert.ok(Array.isArray(data.female), 'female must be an array');
  // With empty manifest, default is null. When populated, it is an object
  // with { imageId, avatarUrls }.
  if (data.default !== null) {
    const def = data.default as { imageId: string; avatarUrls: Record<string, string> };
    assert.equal(typeof def.imageId, 'string');
    assert.equal(typeof def.avatarUrls, 'object');
  }
  assert.deepEqual(Object.keys(data).sort(), ['default', 'female', 'male']);
});

test('GET /images/presets (disabled) returns 503 IMAGES_DISABLED envelope', async () => {
  process.env.USE_CLOUDFLARE_IMAGES = 'false';
  const { res, captured } = mockRes();
  await getPresetAvatarsHandler(mockReq(), res);
  assert.equal(captured.statusCode, 503);
  const body = captured.body as { success: boolean; code: string; error: string };
  assert.equal(body.success, false);
  assert.equal(body.code, 'IMAGES_DISABLED');
  assert.equal(typeof body.error, 'string');
  assert.deepEqual(Object.keys(body).sort(), ['code', 'error', 'success']);
});

// ── POST /images/direct-upload (validation errors only — no network) ─────
test('POST /images/direct-upload (disabled) returns 503 IMAGES_DISABLED + degraded header', async () => {
  process.env.USE_CLOUDFLARE_IMAGES = 'false';
  const { res, captured } = mockRes();
  await createDirectUploadHandler(
    mockReq({ purpose: 'creator-avatar', declaredSizeBytes: 1024 }, { firebaseUid: 'uid-1' }),
    res,
  );
  assert.equal(captured.statusCode, 503);
  const body = captured.body as { success: boolean; code: string; error: string };
  assert.equal(body.success, false);
  assert.equal(body.code, 'IMAGES_DISABLED');
  assert.equal(
    captured.headers['x-image-service-degraded'],
    '1',
    'disabled state MUST set degraded header so Flutter banner surfaces',
  );
});

test('GET /images/presets (disabled) sets X-Image-Service-Degraded:1', async () => {
  process.env.USE_CLOUDFLARE_IMAGES = 'false';
  const { res, captured } = mockRes();
  await getPresetAvatarsHandler(mockReq(), res);
  assert.equal(captured.statusCode, 503);
  assert.equal(captured.headers['x-image-service-degraded'], '1');
});

test('GET /images/health (enabled) does NOT set degraded header', async () => {
  process.env.USE_CLOUDFLARE_IMAGES = 'true';
  const { res, captured } = mockRes();
  await getImagesHealthHandler(mockReq(), res);
  assert.equal(captured.statusCode, 200);
  assert.equal(captured.headers['x-image-service-degraded'], undefined);
});

test('POST /images/direct-upload (no auth) returns 401 unauthenticated', async () => {
  process.env.USE_CLOUDFLARE_IMAGES = 'true';
  const { res, captured } = mockRes();
  await createDirectUploadHandler(
    mockReq({ purpose: 'creator-avatar', declaredSizeBytes: 1024 }),
    res,
  );
  assert.equal(captured.statusCode, 401);
  const body = captured.body as { success: boolean; error: string };
  assert.equal(body.success, false);
  assert.equal(body.error, 'unauthenticated');
});

test('POST /images/direct-upload (invalid purpose) returns 400 INVALID_PURPOSE', async () => {
  process.env.USE_CLOUDFLARE_IMAGES = 'true';
  const { res, captured } = mockRes();
  await createDirectUploadHandler(
    mockReq({ purpose: 'bogus-purpose', declaredSizeBytes: 1024 }, { firebaseUid: 'uid-1' }),
    res,
  );
  assert.equal(captured.statusCode, 400);
  const body = captured.body as { success: boolean; code: string; error: string };
  assert.equal(body.success, false);
  assert.equal(body.code, 'INVALID_PURPOSE');
  assert.ok(body.error.includes('creator-avatar'), 'error must list valid purposes');
});

test('POST /images/direct-upload (invalid size) returns 400 INVALID_SIZE', async () => {
  process.env.USE_CLOUDFLARE_IMAGES = 'true';
  const { res, captured } = mockRes();
  await createDirectUploadHandler(
    mockReq({ purpose: 'creator-avatar', declaredSizeBytes: 0 }, { firebaseUid: 'uid-1' }),
    res,
  );
  assert.equal(captured.statusCode, 400);
  const body = captured.body as { success: boolean; code: string; error: string };
  assert.equal(body.success, false);
  assert.equal(body.code, 'INVALID_SIZE');
});

test('POST /images/direct-upload (file too large) returns 413 FILE_TOO_LARGE', async () => {
  process.env.USE_CLOUDFLARE_IMAGES = 'true';
  const { res, captured } = mockRes();
  await createDirectUploadHandler(
    mockReq(
      { purpose: 'creator-avatar', declaredSizeBytes: 50 * 1024 * 1024 },
      { firebaseUid: 'uid-1' },
    ),
    res,
  );
  assert.equal(captured.statusCode, 413);
  const body = captured.body as { success: boolean; code: string; error: string };
  assert.equal(body.success, false);
  assert.equal(body.code, 'FILE_TOO_LARGE');
});

// ── Wire-shape invariants ────────────────────────────────────────────────
test('every /images/* error envelope carries { success:false, code, error }', async () => {
  // Mixing the three validation responses above we expect a stable error envelope.
  process.env.USE_CLOUDFLARE_IMAGES = 'true';
  const probes: Array<{ name: string; body: Record<string, unknown> }> = [
    { name: 'INVALID_PURPOSE', body: { purpose: 'bogus', declaredSizeBytes: 1024 } },
    { name: 'INVALID_SIZE', body: { purpose: 'creator-avatar', declaredSizeBytes: 'not-a-number' } },
    { name: 'FILE_TOO_LARGE', body: { purpose: 'creator-avatar', declaredSizeBytes: 50 * 1024 * 1024 } },
  ];
  for (const probe of probes) {
    const { res, captured } = mockRes();
    await createDirectUploadHandler(mockReq(probe.body, { firebaseUid: 'uid-1' }), res);
    const body = captured.body as Record<string, unknown>;
    assert.equal(body.success, false, `${probe.name}: success must be false`);
    assert.equal(typeof body.code, 'string', `${probe.name}: code must be string`);
    assert.equal(typeof body.error, 'string', `${probe.name}: error must be string`);
  }
});

// ── Routing surface lock ────────────────────────────────────────────────
test('images.routes registers /health, /direct-upload, /presets only', () => {
  // Lock route surface via source inspection: drift in this file would
  // change the public HTTP surface and must be reviewed.
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const src = readFileSync(join(__dirname, '..', 'images.routes.ts'), 'utf8');
  assert.ok(src.includes("router.get('/health'"), 'GET /health must be registered');
  assert.ok(src.includes("router.post(\n  '/direct-upload'"), 'POST /direct-upload must be registered');
  assert.ok(src.includes("router.get('/presets'"), 'GET /presets must be registered');
  // The legacy gallery URL backfill endpoint must NOT be re-introduced.
  assert.ok(!src.includes('backfill-gallery'), 'backfill endpoints must not leak into images.routes');
});
