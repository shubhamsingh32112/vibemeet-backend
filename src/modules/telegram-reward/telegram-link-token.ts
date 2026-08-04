import { createHmac, timingSafeEqual } from 'crypto';
import {
  getTelegramLinkTokenSecret,
  TELEGRAM_LINK_TOKEN_TTL_MS,
} from './telegram-reward.config';

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLen), 'base64');
}

function sign(payload: string, secret: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(payload).digest());
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Payload format (before base64url of whole token):
 *   userId.exp.sig
 * where sig = HMAC-SHA256(userId.exp)
 * Outer deep-link start arg is base64url(userId.exp.sig) without dots escaping issues.
 */
export function createTelegramLinkPayload(userId: string, now = Date.now()): string {
  const secret = getTelegramLinkTokenSecret();
  if (!secret) {
    throw new Error('TELEGRAM_LINK_TOKEN_SECRET (or JWT_SECRET) is not configured');
  }
  const exp = now + TELEGRAM_LINK_TOKEN_TTL_MS;
  const body = `${userId}.${exp}`;
  const sig = sign(body, secret);
  return base64UrlEncode(`${body}.${sig}`);
}

export function verifyTelegramLinkPayload(
  startPayload: string,
  now = Date.now()
): { userId: string } | null {
  const secret = getTelegramLinkTokenSecret();
  if (!secret || !startPayload) return null;

  let decoded: string;
  try {
    decoded = base64UrlDecode(startPayload.trim()).toString('utf8');
  } catch {
    return null;
  }

  const parts = decoded.split('.');
  if (parts.length !== 3) return null;
  const [userId, expStr, sig] = parts;
  if (!userId || !expStr || !sig) return null;

  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < now) return null;

  const body = `${userId}.${expStr}`;
  const expected = sign(body, secret);
  if (!safeEqual(sig, expected)) return null;

  return { userId };
}
