/**
 * Generates backend/docs/openapi.yaml from Express route files.
 * Run: node scripts/generate-openapi.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..');
const modulesDir = path.join(backendRoot, 'src', 'modules');

/** @type {Record<string, string>} import name -> mount prefix */
const ROUTE_IMPORTS = {
  authRoutes: '/auth',
  referralRoutes: '/referral',
  userRoutes: '/user',
  creatorRoutes: '/creator',
  chatRoutes: '/chat',
  videoRoutes: '/video',
  adminRoutes: '/admin',
  bdRoutes: '/bd',
  agencyRoutes: '/agency',
  billingRoutes: '/billing',
  supportRoutes: '/support',
  paymentRoutes: '/payment',
  appUpdateRoutes: '/app-updates',
  availabilityRoutes: '/availability',
  imagesRoutes: '/images',
  metricsRoutes: '/metrics',
  storiesRoutes: '/stories',
  momentsRoutes: '/moments',
  streamRoutes: '/stream',
  vipRoutes: '/vip',
};

/** @type {Record<string, string>} import name -> relative path from modules dir */
const ROUTE_FILES = {
  authRoutes: 'auth/auth.routes.ts',
  referralRoutes: 'referral/referral.routes.ts',
  userRoutes: 'user/user.routes.ts',
  creatorRoutes: 'creator/creator.routes.ts',
  chatRoutes: 'chat/chat.routes.ts',
  videoRoutes: 'video/video.routes.ts',
  adminRoutes: 'admin/admin.routes.ts',
  bdRoutes: 'bd/bd.routes.ts',
  agencyRoutes: 'agency/agency.routes.ts',
  billingRoutes: 'billing/billing.routes.ts',
  supportRoutes: 'support/support.routes.ts',
  paymentRoutes: 'payment/payment.routes.ts',
  appUpdateRoutes: 'app-update/app-update.routes.ts',
  availabilityRoutes: 'availability/availability.routes.ts',
  imagesRoutes: 'images/images.routes.ts',
  metricsRoutes: 'metrics/metrics.routes.ts',
  storiesRoutes: 'stories/routes/stories.routes.ts',
  momentsRoutes: 'moments/routes/moments.routes.ts',
  streamRoutes: 'stream/stream.routes.ts',
  vipRoutes: 'vip/vip.routes.ts',
};

const ROUTE_RE =
  /router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;

const INFRA_ROUTES = [
  { method: 'get', path: '/health', tag: 'Infrastructure', summary: 'Liveness probe' },
  { method: 'get', path: '/live', tag: 'Infrastructure', summary: 'Simple liveness' },
  { method: 'get', path: '/ready', tag: 'Infrastructure', summary: 'Readiness (Mongo + Redis)' },
  { method: 'get', path: '/metrics', tag: 'Infrastructure', summary: 'Ops metrics dashboard' },
];

/** @param {string} routePath */
function inferAuth(routePath, fileContent, line) {
  if (line.includes('verifyStreamWebhookSignature') || line.includes('verifyRazorpayWebhookSignature')) {
    return 'webhookSignature';
  }
  if (line.includes('verifyStreamWebhook') || (routePath.endsWith('/webhook') && fileContent.includes('webhook'))) {
    return 'webhookSignature';
  }
  if (line.includes('verifyFirebaseToken')) return 'bearerAuth';
  if (routePath === '/preview' || routePath.includes('create-order') || routePath.includes('/web/verify')) {
    return 'none';
  }
  if (routePath === '/plan' && fileContent.includes('vip.routes')) return 'none';
  if (routePath === '/health' || routePath.startsWith('/images/health')) return 'none';
  return 'bearerAuth';
}

/** @param {string} mount */
function tagFromMount(mount) {
  const name = mount.replace(/^\//, '').replace(/-/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** @type {Array<{method:string,fullPath:string,tag:string,auth:string}>} */
const endpoints = [];

for (const [importName, mount] of Object.entries(ROUTE_IMPORTS)) {
  const rel = ROUTE_FILES[importName];
  const filePath = path.join(modulesDir, rel);
  if (!fs.existsSync(filePath)) continue;
  const content = fs.readFileSync(filePath, 'utf8');
  const tag = tagFromMount(mount);
  let m;
  ROUTE_RE.lastIndex = 0;
  while ((m = ROUTE_RE.exec(content)) !== null) {
    const method = m[1].toLowerCase();
    const routePath = m[2];
    const lineStart = content.lastIndexOf('\n', m.index) + 1;
    const lineEnd = content.indexOf('\n', m.index);
    const line = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
    const fullPath = `/api/v1${mount}${routePath.startsWith('/') ? routePath : `/${routePath}`}`;
    endpoints.push({
      method,
      fullPath: fullPath.replace(/\/+/g, '/'),
      tag,
      auth: inferAuth(routePath, content, line),
    });
  }
}

for (const r of INFRA_ROUTES) {
  endpoints.push({
    method: r.method,
    fullPath: r.path,
    tag: r.tag,
    auth: r.path === '/metrics' ? 'metricsToken' : 'none',
  });
}

endpoints.sort((a, b) => a.fullPath.localeCompare(b.fullPath) || a.method.localeCompare(b.method));

const tags = [...new Set(endpoints.map((e) => e.tag))].sort();

function yamlEscape(s) {
  return s.replace(/"/g, '\\"');
}

let yaml = `openapi: 3.0.3
info:
  title: Eazy Talks / Match Vibe Backend API
  description: |
    Auto-generated from Express route files (scripts/generate-openapi.mjs).
    Base path for API modules is /api/v1. Regenerate after route changes.
  version: 1.0.0
  contact:
    name: zztherapy backend

servers:
  - url: http://localhost:3000
    description: Local development
  - url: https://api.prestigeinteriordesign.com
    description: Production (set PUBLIC_API_BASE_URL host)

tags:
${tags.map((t) => `  - name: ${t}`).join('\n')}

components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT or Firebase ID token
      description: Staff JWT from /auth/admin-login, /agency-login, /bd-login OR Firebase ID token for mobile
    webhookSignature:
      type: apiKey
      in: header
      name: X-Signature
      description: Provider HMAC signature on raw body (Stream, Razorpay, Cloudflare)
    metricsToken:
      type: apiKey
      in: header
      name: X-Metrics-Token
      description: Optional ops token when METRICS_TOKEN env is set

  schemas:
    SuccessEnvelope:
      type: object
      properties:
        success:
          type: boolean
          example: true
        data:
          type: object
    ErrorEnvelope:
      type: object
      properties:
        success:
          type: boolean
          example: false
        error:
          type: string

paths:
`;

/** @type {Map<string, typeof endpoints>} */
const byPath = new Map();
for (const ep of endpoints) {
  if (!byPath.has(ep.fullPath)) byPath.set(ep.fullPath, []);
  byPath.get(ep.fullPath).push(ep);
}

for (const [fullPath, eps] of [...byPath.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  yaml += `  "${yamlEscape(fullPath)}":\n`;
  for (const ep of eps) {
    const opId = `${ep.method}_${fullPath.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_')}`;
    yaml += `    ${ep.method}:\n`;
    yaml += `      tags:\n        - ${ep.tag}\n`;
    yaml += `      operationId: ${opId.slice(0, 80)}\n`;
    yaml += `      summary: ${ep.tag} ${ep.method.toUpperCase()} ${fullPath}\n`;
    if (ep.auth === 'bearerAuth') {
      yaml += `      security:\n        - bearerAuth: []\n`;
    } else if (ep.auth === 'webhookSignature') {
      yaml += `      security:\n        - webhookSignature: []\n`;
    } else if (ep.auth === 'metricsToken') {
      yaml += `      security:\n        - metricsToken: []\n        - {}\n`;
    }
    yaml += `      responses:\n`;
    yaml += `        '200':\n          description: Success\n`;
    yaml += `          content:\n            application/json:\n              schema:\n                $ref: '#/components/schemas/SuccessEnvelope'\n`;
    yaml += `        '4XX':\n          description: Client error\n`;
    yaml += `        '5XX':\n          description: Server error\n`;
  }
}

const outPath = path.join(backendRoot, 'docs', 'openapi.yaml');
fs.writeFileSync(outPath, yaml, 'utf8');
console.log(`Wrote ${endpoints.length} operations to ${outPath}`);
