import axios from 'axios';
import { createHash } from 'crypto';
import { getRedis, isRedisConfigured } from '../../config/redis';
import { acquireDistributedLock } from '../../utils/distributed-lock';
import { logError, logInfo, logWarning } from '../../utils/logger';
import { RazorpayCapturedPayment } from '../payment/razorpay-captured-payment.model';
import { RazorpayProjectionBackfill } from '../payment/razorpay-projection-backfill.model';

const PAGE_SIZE = 100;
const MAX_PAGES = Math.max(1, Number(process.env.RAZORPAY_COLLECTED_MAX_PAGES ?? 500));
const MAX_SCAN_MS = Math.max(5_000, Number(process.env.RAZORPAY_COLLECTED_MAX_SCAN_MS ?? 25_000));
const CURRENT_BUCKET_MS = 30_000;
const LOCK_TTL_MS = Math.max(30_000, MAX_SCAN_MS + 10_000);
const CACHE_PREFIX = 'admin:razorpay-collected:v1:';
const inProcess = new Map<string, Promise<RazorpayCollectedAmount>>();

export type RazorpayPaymentForCollected = {
  id: string;
  amount: number;
  currency: string;
  captured: boolean;
  status?: string;
  created_at: number;
};

export type RazorpayPaymentPage = {
  items: RazorpayPaymentForCollected[];
};

export type CollectedCurrencyBucket = {
  currency: string;
  amountSubunits: string;
  amountMajor: string;
  paymentCount: number;
};

export type RazorpayCollectedAmount = {
  configured: true;
  amountSubunits: string | null;
  amountMajor: string | null;
  currency: string | null;
  paymentCount: number;
  currencyBuckets: CollectedCurrencyBucket[];
  requestedRange: { from: string; to: string } | null;
  effectiveRange: { from: string | null; to: string };
  asOf: string;
  cache: 'miss' | 'hit' | 'stale';
  stale: boolean;
  dataMode: 'provider_scan' | 'projection';
  timestampBasis: 'payment_created_at';
  completeness: {
    complete: boolean;
    status: 'not_started' | 'pending' | 'running' | 'failed' | 'complete';
    backfillAsOf: string | null;
    completedAt: string | null;
    projectedPayments: number;
  };
  note: string;
};

export class RazorpayCollectedError extends Error {
  constructor(
    public readonly code:
      | 'NOT_CONFIGURED'
      | 'PROVIDER_AUTH'
      | 'PROVIDER_RATE_LIMIT'
      | 'PROVIDER_UNAVAILABLE'
      | 'PROVIDER_MALFORMED'
      | 'SCAN_LIMIT'
      | 'SCAN_BUSY',
    message: string,
    public readonly status: number = 503
  ) {
    super(message);
  }
}

type ScanOptions = {
  from?: Date;
  to?: Date;
  asOf?: Date;
  fetchPage: (params: { count: number; skip: number; from?: number; to: number }) => Promise<unknown>;
  maxPages?: number;
  maxScanMs?: number;
};

export function parseRazorpayPaymentPage(raw: unknown): RazorpayPaymentPage {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { items?: unknown }).items)) {
    throw new RazorpayCollectedError('PROVIDER_MALFORMED', 'Razorpay returned an invalid payments page.');
  }
  const items = (raw as { items: unknown[] }).items.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new RazorpayCollectedError('PROVIDER_MALFORMED', 'Razorpay returned an invalid payment.');
    }
    const row = entry as Record<string, unknown>;
    if (
      typeof row.id !== 'string' ||
      !Number.isSafeInteger(row.amount) ||
      (row.amount as number) < 0 ||
      typeof row.currency !== 'string' ||
      typeof row.captured !== 'boolean' ||
      !Number.isInteger(row.created_at)
    ) {
      throw new RazorpayCollectedError('PROVIDER_MALFORMED', 'Razorpay returned an invalid payment shape.');
    }
    return {
      id: row.id,
      amount: row.amount as number,
      currency: row.currency.toUpperCase(),
      captured: row.captured,
      status: typeof row.status === 'string' ? row.status : undefined,
      created_at: row.created_at as number,
    };
  });
  return { items };
}

function safeAdd(a: bigint, amount: number): bigint {
  return a + BigInt(amount);
}

function majorAmount(subunits: bigint): string {
  const negative = subunits < 0n;
  const absolute = negative ? -subunits : subunits;
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

export async function scanRazorpayCollectedPayments(options: ScanOptions): Promise<RazorpayCollectedAmount> {
  const scanStartedAt = options.asOf ?? new Date();
  const requestedTo = options.to;
  const effectiveTo = new Date(
    Math.min(requestedTo?.getTime() ?? scanStartedAt.getTime(), scanStartedAt.getTime())
  );
  const startedMs = Date.now();
  const seen = new Set<string>();
  const totals = new Map<string, { amount: bigint; paymentCount: number }>();
  let paymentCount = 0;

  const providerFrom = options.from
    ? Math.max(0, Math.floor(options.from.getTime() / 1000) - 1)
    : undefined;
  const providerTo = Math.ceil(effectiveTo.getTime() / 1000) + 1;
  const maxPages = options.maxPages ?? MAX_PAGES;
  const maxScanMs = options.maxScanMs ?? MAX_SCAN_MS;

  for (let pageNumber = 0; ; pageNumber += 1) {
    if (pageNumber >= maxPages || Date.now() - startedMs > maxScanMs) {
      throw new RazorpayCollectedError(
        'SCAN_LIMIT',
        'Razorpay payment history exceeded the safe request-time scan limit.'
      );
    }
    const page = parseRazorpayPaymentPage(
      await options.fetchPage({
        count: PAGE_SIZE,
        skip: pageNumber * PAGE_SIZE,
        ...(providerFrom === undefined ? {} : { from: providerFrom }),
        to: providerTo,
      })
    );

    for (const payment of page.items) {
      if (seen.has(payment.id)) continue;
      seen.add(payment.id);
      const createdMs = payment.created_at * 1000;
      if (options.from && createdMs < options.from.getTime()) continue;
      if (createdMs >= effectiveTo.getTime()) continue;
      // Razorpay can retain status=refunded after capture. `captured` is the authoritative inclusion flag.
      if (payment.captured !== true) continue;
      const bucket = totals.get(payment.currency) ?? { amount: 0n, paymentCount: 0 };
      bucket.amount = safeAdd(bucket.amount, payment.amount);
      bucket.paymentCount += 1;
      totals.set(payment.currency, bucket);
      paymentCount += 1;
    }

    if (page.items.length < PAGE_SIZE) break;
  }

  const currencyBuckets = [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, value]) => ({
      currency,
      amountSubunits: value.amount.toString(),
      amountMajor: majorAmount(value.amount),
      paymentCount: value.paymentCount,
    }));
  const soleBucket = currencyBuckets.length === 1 ? currencyBuckets[0] : null;

  return {
    configured: true,
    amountSubunits: soleBucket?.amountSubunits ?? (currencyBuckets.length === 0 ? '0' : null),
    amountMajor: soleBucket?.amountMajor ?? (currencyBuckets.length === 0 ? '0.00' : null),
    currency: soleBucket?.currency ?? (currencyBuckets.length === 0 ? 'INR' : null),
    paymentCount,
    currencyBuckets,
    requestedRange:
      options.from && requestedTo
        ? { from: options.from.toISOString(), to: requestedTo.toISOString() }
        : null,
    effectiveRange: {
      from: options.from?.toISOString() ?? null,
      to: effectiveTo.toISOString(),
    },
    asOf: scanStartedAt.toISOString(),
    cache: 'miss',
    stale: false,
    dataMode: 'provider_scan',
    timestampBasis: 'payment_created_at',
    completeness: {
      complete: true,
      status: 'complete',
      backfillAsOf: scanStartedAt.toISOString(),
      completedAt: scanStartedAt.toISOString(),
      projectedPayments: paymentCount,
    },
    note:
      'Gross captured Razorpay payments, including refunded payments, filtered locally as a half-open range on payment.created_at.',
  };
}

function retryableProviderError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  return status === 429 || (typeof status === 'number' && status >= 500) || !error.response;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchRazorpayPaymentsPage(
  params: { count: number; skip: number; from?: number; to: number },
  attempt = 0
): Promise<unknown> {
  try {
    const response = await axios.get('https://api.razorpay.com/v1/payments', {
      auth: {
        username: String(process.env.RAZORPAY_KEY_ID ?? ''),
        password: String(process.env.RAZORPAY_KEY_SECRET ?? ''),
      },
      params,
      timeout: 10_000,
    });
    return response.data;
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    if (retryableProviderError(error) && attempt < 2) {
      const retryAfterSeconds = axios.isAxiosError(error)
        ? Number(error.response?.headers?.['retry-after'] ?? 0)
        : 0;
      const backoff = retryAfterSeconds > 0
        ? Math.min(5_000, retryAfterSeconds * 1000)
        : 250 * 2 ** attempt + Math.floor(Math.random() * 150);
      await delay(backoff);
      return fetchRazorpayPaymentsPage(params, attempt + 1);
    }
    if (status === 401 || status === 403) {
      throw new RazorpayCollectedError('PROVIDER_AUTH', 'Razorpay rejected the configured credentials.');
    }
    if (status === 429) {
      throw new RazorpayCollectedError('PROVIDER_RATE_LIMIT', 'Razorpay rate limit was exceeded.');
    }
    throw new RazorpayCollectedError('PROVIDER_UNAVAILABLE', 'Razorpay payments are temporarily unavailable.');
  }
}

export function razorpayModeName(): 'test' | 'live' {
  return String(process.env.RAZORPAY_KEY_ID ?? '').startsWith('rzp_test_') ? 'test' : 'live';
}

function cacheIdentity(from: Date | undefined, requestedTo: Date | undefined, effectiveTo: Date): string {
  const raw = `${razorpayModeName()}|all-currencies|${from?.toISOString() ?? 'all'}|${requestedTo?.toISOString() ?? 'all'}|${effectiveTo.toISOString()}`;
  return createHash('sha256').update(raw).digest('hex');
}

function parseCached(raw: string | null, cache: 'hit' | 'stale'): RazorpayCollectedAmount | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RazorpayCollectedAmount;
    if (!parsed || parsed.configured !== true || !Array.isArray(parsed.currencyBuckets)) return null;
    return { ...parsed, cache, stale: cache === 'stale' };
  } catch {
    return null;
  }
}

async function readRedis(key: string): Promise<string | null> {
  if (!isRedisConfigured()) return null;
  try {
    return await getRedis().get(key);
  } catch (error) {
    logWarning('razorpay_collected_cache_read_failed', { key, error: String(error) });
    return null;
  }
}

async function writeRedis(key: string, latestKey: string, value: RazorpayCollectedAmount, ttl: number): Promise<void> {
  if (!isRedisConfigured()) return;
  try {
    const serialized = JSON.stringify(value);
    await getRedis()
      .multi()
      .setex(key, ttl, serialized)
      .setex(latestKey, Math.max(ttl * 12, 3600), serialized)
      .exec();
  } catch (error) {
    logWarning('razorpay_collected_cache_write_failed', { key, error: String(error) });
  }
}

async function waitForCache(key: string): Promise<RazorpayCollectedAmount | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delay(250);
    const cached = parseCached(await readRedis(key), 'hit');
    if (cached) return cached;
  }
  return null;
}

async function dashboardRazorpayCollectedAllTimeProjection(): Promise<RazorpayCollectedAmount> {
  const mode = razorpayModeName();
  const [rows, backfill, projectedPayments] = await Promise.all([
    RazorpayCapturedPayment.aggregate<{
      _id: string;
      amount: { toString(): string };
      paymentCount: number;
    }>([
      { $match: { providerMode: mode } },
      {
        $group: {
          _id: '$currency',
          amount: { $sum: { $toDecimal: '$amountSubunits' } },
          paymentCount: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    RazorpayProjectionBackfill.findOne({ mode }).lean(),
    RazorpayCapturedPayment.countDocuments({ providerMode: mode }),
  ]);
  const currencyBuckets = rows.map((row) => {
    const amountSubunits = row.amount.toString().replace(/\.0+$/, '');
    return {
      currency: row._id,
      amountSubunits,
      amountMajor: majorAmount(BigInt(amountSubunits)),
      paymentCount: row.paymentCount,
    };
  });
  const soleBucket = currencyBuckets.length === 1 ? currencyBuckets[0] : null;
  const status = backfill?.status ?? 'not_started';
  const complete = status === 'complete';
  const now = new Date();

  return {
    configured: true,
    amountSubunits: soleBucket?.amountSubunits ?? (currencyBuckets.length === 0 ? '0' : null),
    amountMajor: soleBucket?.amountMajor ?? (currencyBuckets.length === 0 ? '0.00' : null),
    currency: soleBucket?.currency ?? (currencyBuckets.length === 0 ? 'INR' : null),
    paymentCount: projectedPayments,
    currencyBuckets,
    requestedRange: null,
    effectiveRange: { from: null, to: now.toISOString() },
    asOf: now.toISOString(),
    cache: 'miss',
    stale: false,
    dataMode: 'projection',
    timestampBasis: 'payment_created_at',
    completeness: {
      complete,
      status,
      backfillAsOf: backfill?.asOf?.toISOString() ?? null,
      completedAt: backfill?.completedAt?.toISOString() ?? null,
      projectedPayments,
    },
    note: complete
      ? 'All-time gross captured payments from the durable projection; historical backfill is complete.'
      : `Partial All-time projection; historical backfill status is ${status}.`,
  };
}

export async function dashboardRazorpayCollectedAmount(
  range?: { from: Date; to: Date }
): Promise<RazorpayCollectedAmount> {
  if (!range) {
    return dashboardRazorpayCollectedAllTimeProjection();
  }
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new RazorpayCollectedError('NOT_CONFIGURED', 'Razorpay credentials are not configured.');
  }

  const rawAsOf = Date.now();
  const requestedTo = range?.to;
  const currentRange = !requestedTo || requestedTo.getTime() > rawAsOf;
  const frozenMs = currentRange ? Math.floor(rawAsOf / CURRENT_BUCKET_MS) * CURRENT_BUCKET_MS : requestedTo.getTime();
  const asOf = new Date(frozenMs);
  const effectiveTo = new Date(Math.min(requestedTo?.getTime() ?? frozenMs, frozenMs));
  const identity = cacheIdentity(range?.from, requestedTo, effectiveTo);
  const cacheKey = `${CACHE_PREFIX}${identity}`;
  const latestKey = `${CACHE_PREFIX}latest:${createHash('sha256')
    .update(`${razorpayModeName()}|${range?.from?.toISOString() ?? 'all'}|${requestedTo?.toISOString() ?? 'all'}`)
    .digest('hex')}`;
  const cached = parseCached(await readRedis(cacheKey), 'hit');
  if (cached) return cached;

  const existing = inProcess.get(cacheKey);
  if (existing) return existing;

  const work = (async () => {
    let lock: Awaited<ReturnType<typeof acquireDistributedLock>> = null;
    if (isRedisConfigured()) {
      lock = await acquireDistributedLock({
        key: `${cacheKey}:lock`,
        ttlMs: LOCK_TTL_MS,
        ownerId: `admin-razorpay-${process.pid}`,
        heartbeat: true,
      });
      if (!lock) {
        const filled = await waitForCache(cacheKey);
        if (filled) return filled;
        const stale = parseCached(await readRedis(latestKey), 'stale');
        if (stale) return stale;
        throw new RazorpayCollectedError('SCAN_BUSY', 'Razorpay collection scan is already running.');
      }
    }

    try {
      const value = await scanRazorpayCollectedPayments({
        from: range?.from,
        to: requestedTo,
        asOf,
        fetchPage: fetchRazorpayPaymentsPage,
      });
      const ttl = range ? (currentRange ? 60 : 600) : 3600;
      await writeRedis(cacheKey, latestKey, value, ttl);
      logInfo('razorpay_collected_scan_complete', {
        paymentCount: value.paymentCount,
        currencyCount: value.currencyBuckets.length,
        asOf: value.asOf,
        allTime: !range,
      });
      return value;
    } catch (error) {
      const stale = parseCached(await readRedis(latestKey), 'stale');
      if (stale) {
        logWarning('razorpay_collected_serving_stale', { error: String(error), asOf: stale.asOf });
        return stale;
      }
      logError('razorpay_collected_scan_failed', error as Error);
      throw error;
    } finally {
      await lock?.release();
    }
  })();

  inProcess.set(cacheKey, work);
  try {
    return await work;
  } finally {
    inProcess.delete(cacheKey);
  }
}
