import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('website visit analytics expose public ingest and admin unique count', () => {
  const routes = readFileSync(join(__dirname, '../../routes.ts'), 'utf8');
  const analyticsRoutes = readFileSync(join(__dirname, 'analytics.routes.ts'), 'utf8');
  const adminRoutes = readFileSync(join(__dirname, '../admin/admin.routes.ts'), 'utf8');
  const controller = readFileSync(join(__dirname, 'website-visits.controller.ts'), 'utf8');
  const model = readFileSync(join(__dirname, 'website-homepage-visit-day.model.ts'), 'utf8');

  assert.match(routes, /analyticsRoutes/);
  assert.match(analyticsRoutes, /website-homepage-visit/);
  assert.match(adminRoutes, /\/analytics\/website-visits/);
  assert.match(controller, /recordWebsiteHomepageVisit/);
  assert.match(controller, /getWebsiteVisits/);
  assert.match(controller, /countDocuments\(match\)/);
  assert.match(controller, /uniqueness: 'visitor_per_ist_day'/);
  assert.match(controller, /coverage: 'forward_only'/);
  assert.match(model, /visitorId: 1, day: 1/);
});
