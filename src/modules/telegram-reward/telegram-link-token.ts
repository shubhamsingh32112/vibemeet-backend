import { createHmac, timingSafeEqual } from 'crypto';
import {
  getTelegramLinkTokenSecret,
  TELEGRAM_LINK_TOKEN_TTL_MS,
} from './telegram-reward.config';

/**
 * Telegram deep-link `start` payload max length is 64 characters.
 * Compact binary format (base64url):
 *   ObjectId(12) || expUnixSec BE u32 (4) || HMAC-SHA256(body)[:10] (10)
 * → 26 bytes → ~35 base64url chars (fits well under 64).
 */
const OBJECT_ID_BYTES = 12;
const EXP_BYTES = 4;
const SIG_BYTES = 10;
const PAYLOAD_BYTES = OBJECT_ID_BYTES + EXP_BYTES + SIG_BYTES;

function base64UrlEncode(input: Buffer): string {
  return input
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

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function hmacBody(body: Buffer, secret: string): Buffer {
  return createHmac('sha256', secret).update(body).digest().subarray(0, SIG_BYTES);
}

function isHexObjectId(userId: string): boolean {
  return /^[a-f0-9]{24}$/i.test(userId);
}

/**
 * Create a signed start payload for `https://t.me/<bot>?start=<payload>`.
 * Must stay ≤ 64 characters (Telegram Bot API limit).
 */
export function createTelegramLinkPayload(userId: string, now = Date.now()): string {
  const secret = getTelegramLinkTokenSecret();
  if (!secret) {
    throw new Error('TELEGRAM_LINK_TOKEN_SECRET (or JWT_SECRET) is not configured');
  }
  if (!isHexObjectId(userId)) {
    throw new Error('userId must be a 24-char hex ObjectId');
  }

  const idBuf = Buffer.from(userId.toLowerCase(), 'hex');
  const expSec = Math.floor((now + TELEGRAM_LINK_TOKEN_TTL_MS) / 1000);
  const expBuf = Buffer.alloc(EXP_BYTES);
  expBuf.writeUInt32BE(expSec >>> 0, 0);

  const body = Buffer.concat([idBuf, expBuf]);
  const sig = hmacBody(body, secret);
  const payload = base64UrlEncode(Buffer.concat([body, sig]));

  if (payload.length > 64) {
    // Defensive — binary layout must never exceed Telegram's start limit.
    throw new Error(`Telegram start payload too long (${payload.length})`);
  }
  return payload;
}

export function verifyTelegramLinkPayload(
  startPayload: string,
  now = Date.now()
): { userId: string } | null {
  const secret = getTelegramLinkTokenSecret();
  if (!secret || !startPayload) return null;

  let buf: Buffer;
  try {
    buf = base64UrlDecode(startPayload.trim());
  } catch {
    return null;
  }

  if (buf.length !== PAYLOAD_BYTES) return null;

  const body = buf.subarray(0, OBJECT_ID_BYTES + EXP_BYTES);
  const sig = buf.subarray(OBJECT_ID_BYTES + EXP_BYTES);
  const expected = hmacBody(body, secret);
  if (!safeEqual(sig, expected)) return null;

  const expSec = body.readUInt32BE(OBJECT_ID_BYTES);
  if (!Number.isFinite(expSec) || expSec * 1000 < now) return null;

  const userId = body.subarray(0, OBJECT_ID_BYTES).toString('hex');
  if (!isHexObjectId(userId)) return null;

  return { userId };
}
