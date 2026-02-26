import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminApplicationService } from '../modules/admin/admin.application.service';
import { CreatorApplicationService } from '../modules/creator/creator.application.service';
import { VideoWebhookApplicationService } from '../modules/video/video-webhook.application.service';
import { PaymentApplicationService } from '../modules/payment/payment.application.service';

test('admin service: shouldUseUsersAnalyticsCache follows filter rules', () => {
  const service = new AdminApplicationService();
  assert.equal(service.shouldUseUsersAnalyticsCache({}), true);
  assert.equal(service.shouldUseUsersAnalyticsCache({ query: 'john' }), false);
  assert.equal(service.shouldUseUsersAnalyticsCache({ role: 'creator' }), false);
  assert.equal(service.shouldUseUsersAnalyticsCache({ role: 'all' }), true);
  assert.equal(service.shouldUseUsersAnalyticsCache({ sort: 'coins' }), false);
});

test('creator service: withdrawal validation enforces business constraints', () => {
  const service = new CreatorApplicationService();
  assert.deepEqual(service.validateWithdrawalRequest(90, 1000), {
    ok: false,
    error: 'Minimum withdrawal amount is 100 coins',
  });
  assert.deepEqual(service.validateWithdrawalRequest(150, 120), {
    ok: false,
    error: 'Insufficient balance. You have 120 coins but requested 150',
  });
  assert.deepEqual(service.validateWithdrawalRequest(200, 500), { ok: true });
});

test('video webhook service: handled webhook type list is explicit', () => {
  const service = new VideoWebhookApplicationService();
  assert.equal(service.isSupportedWebhookType('call.ended'), true);
  assert.equal(service.isSupportedWebhookType('call.session_started'), true);
  assert.equal(service.isSupportedWebhookType('call.unknown'), false);
});

test('payment service: coin request validation and message builder', () => {
  const service = new PaymentApplicationService();
  assert.equal(service.validateCreateOrderCoins(250), true);
  assert.equal(service.validateCreateOrderCoins(0), false);
  assert.equal(service.validateCreateOrderCoins('250'), false);
  assert.equal(
    service.buildInvalidPackageMessage([250, 500, 1000]),
    'Invalid coin package. Valid packages: 250, 500, 1000'
  );
});

