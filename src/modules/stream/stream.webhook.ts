import crypto from 'node:crypto';
import type { Request } from 'express';
import { getCloudflareStreamConfig } from '../../config/cloudflare-stream';

const REPLAY_WINDOW_SEC = 300;

function parseWebhookSignatureHeader(
  header: string,
): { time: string; sig1: string } | null {
  let time: string | undefined;
  let sig1: string | undefined;

  for (const part of header.split(',')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (key === 'time') time = value;
    if (key === 'sig1') sig1 = value;
  }

  if (!time || !sig1) return null;
  return { time, sig1 };
}

function getWebhookRawBody(req: Request): string {
  if (Buffer.isBuffer(req.body)) {
    return req.body.toString('utf8');
  }
  const stored = (req as Request & { rawBody?: string }).rawBody;
  if (typeof stored === 'string') return stored;
  if (typeof req.body === 'string') return req.body;
  return JSON.stringify(req.body);
}

export function verifyStreamWebhook(req: Request): boolean {
  const cfg = getCloudflareStreamConfig();
  if (!cfg.webhookSecret) return false;

  const signatureHeader = req.headers['webhook-signature'] as string | undefined;
  if (!signatureHeader) return false;

  const parsed = parseWebhookSignatureHeader(signatureHeader);
  if (!parsed) return false;

  const ts = Number.parseInt(parsed.time, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > REPLAY_WINDOW_SEC) return false;

  const rawBody = getWebhookRawBody(req);
  const expected = crypto
    .createHmac('sha256', cfg.webhookSecret)
    .update(`${parsed.time}.${rawBody}`)
    .digest('hex');

  try {
    const sigBuf = Buffer.from(parsed.sig1, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}
