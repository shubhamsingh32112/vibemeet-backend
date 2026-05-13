/**
 * Lightweight image pipeline endpoint audit.
 * Usage: node scripts/image-endpoint-audit.mjs [baseUrl]
 * Default baseUrl: http://localhost:3000/api/v1
 */
const base = (process.argv[2] ?? 'http://localhost:3000/api/v1').replace(/\/$/, '');

async function timed(label, fn) {
  const t0 = performance.now();
  try {
    const result = await fn();
    const ms = (performance.now() - t0).toFixed(1);
    return { label, ok: true, ms, ...result };
  } catch (e) {
    const ms = (performance.now() - t0).toFixed(1);
    return { label, ok: false, ms, error: String(e.message ?? e) };
  }
}

async function get(path) {
  const res = await fetch(`${base}${path}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, degraded: res.headers.get('x-image-service-degraded'), body };
}

async function headCdn(url) {
  const res = await fetch(url, { method: 'HEAD' });
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    contentLength: res.headers.get('content-length'),
  };
}

const results = [];

results.push(
  await timed('GET /images/health', async () => {
    const r = await get('/images/health');
    return { status: r.status, degraded: r.degraded, enabled: r.body?.enabled };
  }),
);

results.push(
  await timed('GET /images/presets', async () => {
    const r = await get('/images/presets');
    const male = r.body?.data?.male ?? [];
    const female = r.body?.data?.female ?? [];
    const sampleUrl = male[0]?.avatarUrls?.md ?? female[0]?.avatarUrls?.md ?? null;
    let cdn = null;
    if (sampleUrl) {
      cdn = await timed('CDN preset avatarMd HEAD', () => headCdn(sampleUrl));
    }
    return {
      status: r.status,
      degraded: r.degraded,
      maleCount: male.length,
      femaleCount: female.length,
      sampleUrl,
      cdn,
    };
  }),
);

console.log(JSON.stringify({ base, results }, null, 2));

const failed = results.filter((r) => !r.ok || (r.status && r.status >= 400));
process.exit(failed.length ? 1 : 0);
