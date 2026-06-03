import crypto from 'node:crypto';
import {
  getCloudflareStreamConfig,
  tryGetCloudflareStreamConfig,
} from '../../config/cloudflare-stream';

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64url');
}

function objectToBase64Url(obj: Record<string, unknown>): string {
  return base64UrlEncode(JSON.stringify(obj));
}

let importedKey: crypto.KeyObject | null = null;

async function getSigningKey(): Promise<crypto.KeyObject | null> {
  if (importedKey) return importedKey;
  const cfg = tryGetCloudflareStreamConfig();
  if (!cfg?.signingKeyJwkBase64 || !cfg.signingKeyId) return null;
  try {
    const jwkJson = Buffer.from(cfg.signingKeyJwkBase64, 'base64').toString('utf8');
    const jwk = JSON.parse(jwkJson) as crypto.JsonWebKey;
    importedKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
    return importedKey;
  } catch {
    return null;
  }
}

export async function generateStreamPlaybackToken(videoUid: string): Promise<string | null> {
  const cfg = tryGetCloudflareStreamConfig();
  if (!cfg) return null;

  const key = await getSigningKey();
  if (!key || !cfg.signingKeyId) {
    return videoUid;
  }

  const expiresIn = cfg.tokenTtlSec;
  const exp = Math.floor(Date.now() / 1000) + expiresIn;
  const header = { alg: 'RS256', kid: cfg.signingKeyId };
  const payload = { sub: videoUid, kid: cfg.signingKeyId, exp };

  const unsigned = `${objectToBase64Url(header)}.${objectToBase64Url(payload)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), key);
  return `${unsigned}.${base64UrlEncode(signature)}`;
}

export async function buildSignedPlaybackUrl(videoUid: string): Promise<string> {
  const cfg = getCloudflareStreamConfig();
  const token = (await generateStreamPlaybackToken(videoUid)) ?? videoUid;
  return `https://customer-${cfg.customerCode}.cloudflarestream.com/${token}/manifest/video.m3u8`;
}

export async function buildSignedThumbnailUrl(videoUid: string, height = 600): Promise<string> {
  const cfg = getCloudflareStreamConfig();
  const token = (await generateStreamPlaybackToken(videoUid)) ?? videoUid;
  return `https://customer-${cfg.customerCode}.cloudflarestream.com/${token}/thumbnails/thumbnail.jpg?time=1s&height=${height}`;
}

export function isStreamSigningConfigured(): boolean {
  const cfg = tryGetCloudflareStreamConfig();
  return Boolean(cfg?.signingKeyId && cfg.signingKeyJwkBase64);
}

export function getPlaybackTokenExpiresAtMs(): number {
  const cfg = tryGetCloudflareStreamConfig();
  const ttlSec = cfg?.tokenTtlSec ?? 3600;
  return Date.now() + ttlSec * 1000;
}

export function __resetStreamSigningKeyForTests(): void {
  importedKey = null;
}
