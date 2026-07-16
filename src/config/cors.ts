import type { CorsOptions } from 'cors';
import { logInfo, logWarning } from '../utils/logger';

function escapeRegexLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strip quotes / trailing slash / whitespace that often sneak into env values. */
export function normalizeCorsOriginEntry(entry: string): string {
  let s = entry.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  // Trailing slash never appears on browser Origin headers.
  while (s.length > 1 && s.endsWith('/')) {
    s = s.slice(0, -1);
  }
  return s;
}

/**
 * Expand a single CORS_ORIGIN entry into concrete matchers.
 * - Bare hostnames (`flirtycam.in`) → `https://` (+ `http://` outside production)
 * - Apex ↔ www: listing either also allows the other
 * - Wildcards (`https://*.example.com`) stay as RegExp
 */
export function expandCorsOriginEntry(entry: string): (string | RegExp)[] {
  const trimmed = normalizeCorsOriginEntry(entry);
  if (!trimmed) return [];
  if (trimmed === '*') return ['*'];

  if (trimmed.includes('*')) {
    const safe = escapeRegexLiteral(trimmed).replace(/\\\*/g, '.*');
    return [new RegExp(`^${safe}$`)];
  }

  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return [trimmed];
  }

  const scheme = url.protocol.replace(':', '');
  const host = url.host; // includes port if any
  const origins = new Set<string>();

  origins.add(`${scheme}://${host}`);

  // Also allow the other common scheme in non-production so local/http works.
  if (process.env.NODE_ENV !== 'production') {
    const alt = scheme === 'https' ? 'http' : 'https';
    origins.add(`${alt}://${host}`);
  }

  // Apex ↔ www pairing (same scheme).
  if (host.startsWith('www.')) {
    origins.add(`${scheme}://${host.slice(4)}`);
  } else if (!host.includes(':') && host.split('.').length >= 2) {
    origins.add(`${scheme}://www.${host}`);
  }

  return [...origins];
}

export function parseCorsOriginAllowlist(
  rawEnv: string | undefined = process.env.CORS_ORIGIN,
): (string | RegExp)[] | '*' {
  const raw = (rawEnv || '').trim();
  if (!raw || raw === '*') {
    return '*';
  }

  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap(expandCorsOriginEntry);

  if (parts.length === 0) return '*';
  if (parts.length === 1 && parts[0] === '*') return '*';
  return parts;
}

function originMatches(
  requestOrigin: string,
  allowlist: (string | RegExp)[],
): boolean {
  for (const entry of allowlist) {
    if (typeof entry === 'string') {
      if (entry === '*' || entry === requestOrigin) return true;
    } else if (entry.test(requestOrigin)) {
      return true;
    }
  }
  return false;
}

/**
 * cors package `origin` option: reflect allowed Origin, or deny (no ACAO).
 * Used for both Express HTTP and Socket.IO.
 */
export function buildCorsOriginOption(): CorsOptions['origin'] {
  const allowlist = parseCorsOriginAllowlist();

  if (allowlist === '*') {
    if (process.env.NODE_ENV === 'production') {
      logWarning(
        'CORS_ORIGIN is * or unset in production — set explicit origins for web clients',
        {},
      );
    }
    // credentials:true requires reflecting the request Origin, not `*`.
    return true;
  }

  const concrete = allowlist.filter((e) => typeof e === 'string') as string[];
  logInfo('CORS allowlist loaded', {
    entryCount: allowlist.length,
    sample: concrete.slice(0, 8),
  });

  return (requestOrigin, callback) => {
    // Non-browser / same-origin tools (curl, health checks) send no Origin.
    if (!requestOrigin) {
      callback(null, true);
      return;
    }
    if (originMatches(requestOrigin, allowlist)) {
      callback(null, true);
      return;
    }
    logWarning('CORS origin rejected', {
      origin: requestOrigin,
      allowlistSample: concrete.slice(0, 8),
    });
    callback(null, false);
  };
}

export function buildExpressCorsOptions(): CorsOptions {
  return {
    origin: buildCorsOriginOption(),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'X-Requested-With',
      'x-idempotency-key',
      'X-Idempotency-Key',
      'x-request-id',
      'X-Request-Id',
      'x-correlation-id',
      'X-Correlation-Id',
    ],
    exposedHeaders: ['Content-Length', 'Content-Type'],
    maxAge: 86400,
    optionsSuccessStatus: 204,
    preflightContinue: false,
  };
}

/** Socket.IO accepts the same allowlist shape as the old static builder. */
export function buildSocketCorsOrigin(): boolean | string | RegExp | (string | RegExp)[] {
  const allowlist = parseCorsOriginAllowlist();
  if (allowlist === '*') {
    if (process.env.NODE_ENV === 'production') {
      logWarning(
        'CORS_ORIGIN is * or unset in production — set explicit origins for web clients',
        {},
      );
    }
    return true;
  }
  if (allowlist.length === 1) return allowlist[0];
  return allowlist;
}
