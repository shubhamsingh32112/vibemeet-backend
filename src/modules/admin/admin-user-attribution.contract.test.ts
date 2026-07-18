import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request } from 'express';
import { parseAdminDateRange } from './admin-date-range';

function request(query: Record<string, string>): Request {
  return { query } as unknown as Request;
}

test('attribution ranges are strict half-open bounded pairs', () => {
  const valid = parseAdminDateRange(request({
    from: '2026-07-16T18:30:00.000Z',
    to: '2026-07-17T18:30:00.000Z',
  }));
  assert.equal(valid.hasRange, true);
  assert.equal(valid.from?.toISOString(), '2026-07-16T18:30:00.000Z');
  assert.equal(valid.to?.toISOString(), '2026-07-17T18:30:00.000Z');

  assert.equal(parseAdminDateRange(request({ from: '2026-07-17T00:00:00Z' })).invalidReason, 'missing_to');
  assert.equal(parseAdminDateRange(request({
    from: '2026-07-17',
    to: '2026-07-18',
  })).invalidReason, 'invalid_bounds');
  assert.equal(parseAdminDateRange(request({
    from: '2026-07-18T00:00:00Z',
    to: '2026-07-17T00:00:00Z',
  })).invalidReason, 'invalid_bounds');
});

test('website and login analytics retain global cohort semantics', () => {
  const controller = readFileSync(
    join(__dirname, 'admin-user-attribution.controller.ts'),
    'utf8',
  );
  const routes = readFileSync(join(__dirname, 'admin.routes.ts'), 'utf8');

  assert.match(routes, /router\.get\('\/users\/website', getWebsiteUsers\)/);
  assert.match(routes, /router\.get\('\/users\/login-analytics', getUsersLoginAnalytics\)/);
  assert.match(routes, /router\.get\('\/analytics\/website-visits', getWebsiteVisits\)/);
  assert.match(controller, /websiteAudienceSince = \{ \$gte: range\.from, \$lt: range\.to \}/);
  assert.match(controller, /createdAt: \{ \$lt: range\.from \}, 'authActivity\.0'/);
  assert.match(controller, /eventMatch\.accountCreated = false/);
  assert.ok(controller.indexOf('$sort:') < controller.indexOf('$facet:'));
  assert.match(controller, /coverage: 'forward_only'/);
  assert.match(controller, /authSyncCaveat/);
});
