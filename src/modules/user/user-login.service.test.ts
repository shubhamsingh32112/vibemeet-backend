import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeAuthAnalyticsClaims } from './user-login.service';

test('auth analytics claims are allowlisted and legacy-safe', () => {
  assert.deepEqual(
    normalizeAuthAnalyticsClaims({
      clientPlatform: 'web',
      eventKind: 'interactive_login',
      clientEventId: 'web:12345678',
    }),
    {
      clientPlatform: 'web',
      eventKind: 'interactive_login',
      clientEventId: 'web:12345678',
    },
  );
  assert.deepEqual(normalizeAuthAnalyticsClaims({
    clientPlatform: 'desktop',
    eventKind: 'magic',
    clientEventId: 'bad id',
  }), {
    clientPlatform: 'unknown',
    eventKind: 'legacy_auth_sync',
    clientEventId: undefined,
  });
});

test('website attribution keeps immutable CAS and forward indexes', () => {
  const root = join(__dirname);
  const service = readFileSync(join(root, 'user-login.service.ts'), 'utf8');
  const userModel = readFileSync(join(root, 'user.model.ts'), 'utf8');
  const eventModel = readFileSync(join(root, 'user-login-event.model.ts'), 'utf8');
  const authController = readFileSync(join(root, '../auth/auth.controller.ts'), 'utf8');

  assert.match(service, /websiteAudienceCategory: \{ \$exists: false \}/);
  assert.match(service, /\$max: \{ lastWebsiteLoginAt: observedAt \}/);
  assert.match(service, /if \(!isDuplicateKeyError\(error\)\) throw error/);
  assert.match(service, /stored\.userId\.toString\(\) !== user\._id\.toString\(\)/);
  assert.match(userModel, /websiteAudienceCategory:[\s\S]*immutable: true/);
  assert.match(userModel, /role: 1, websiteAudienceSince: -1, _id: -1/);
  assert.match(eventModel, /unique: true,[\s\S]*clientEventId: \{ \$type: 'string' \}/);
  assert.match(authController, /websiteAudienceCategory: 'created_on_website'/);
  assert.match(authController, /observeExistingWebsiteUser\(user\._id, eventObservedAt \?\? observedAt\)/);
});
