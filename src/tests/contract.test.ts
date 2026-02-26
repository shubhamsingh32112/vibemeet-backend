import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express, { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import routes from '../routes';
import { User } from '../modules/user/user.model';
import { Creator } from '../modules/creator/creator.model';

let mongoServer: MongoMemoryServer;
let app: Express;

const authHeaders = (firebaseUid: string) => ({
  Authorization: 'Bearer contract-test-token',
  'x-test-firebase-uid': firebaseUid,
  'x-test-email': `${firebaseUid}@contract.local`,
});

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.FF_AUTH_BYPASS_FOR_TESTS = 'true';
  process.env.FF_PAYMENT_PROVIDER_MOCK = 'true';
  process.env.FF_BILLING_HTTP_MOCK = 'true';
  process.env.FF_NORMALIZED_RESPONSE_ADAPTER = 'true';
  process.env.JWT_SECRET = 'contract-test-jwt-secret-1234';
  process.env.CHECKOUT_SESSION_SECRET = 'contract-test-checkout-secret-1234';
  process.env.RAZORPAY_KEY_SECRET = 'contract-test-razorpay-secret';
  process.env.RAZORPAY_KEY_ID = 'rzp_test_contract';

  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(express.json());
  app.use('/api/v1', routes);
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await mongoServer.stop();
});

test('contract: /auth/login returns legacy data and normalized auth DTO', async () => {
  const response = await request(app)
    .post('/api/v1/auth/login')
    .set(authHeaders('uid-contract-auth'))
    .send({});

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.ok(response.body.data);
  assert.ok(response.body.normalized);
  assert.equal(response.body.normalized.session.authenticated, true);
  assert.equal(typeof response.body.normalized.user.id, 'string');
  assert.ok(Array.isArray(response.body.meta.deprecations));
});

test('contract: /user/me returns legacy and normalized user profile DTO', async () => {
  const uid = 'uid-contract-user';
  await User.create({
    firebaseUid: uid,
    email: 'contract-user@local.test',
    role: 'user',
    coins: 10,
    freeTextUsed: 0,
    categories: ['focus'],
  });

  const response = await request(app)
    .get('/api/v1/user/me')
    .set(authHeaders(uid));

  assert.equal(response.status, 200);
  assert.ok(response.body.data.user);
  assert.ok(response.body.normalized.user);
  assert.equal(response.body.normalized.user.role, 'user');
  assert.equal(response.body.normalized.creator, null);
});

test('contract: /creator returns legacy creators list and normalized creators DTO', async () => {
  const requesterUid = 'uid-contract-creator-requester';
  const creatorOwnerUid = 'uid-contract-creator-owner';

  const [requester, creatorOwner] = await Promise.all([
    User.create({
      firebaseUid: requesterUid,
      email: 'requester@contract.local',
      role: 'user',
      coins: 0,
      freeTextUsed: 0,
    }),
    User.create({
      firebaseUid: creatorOwnerUid,
      email: 'creator-owner@contract.local',
      role: 'creator',
      coins: 0,
      freeTextUsed: 0,
    }),
  ]);

  await Creator.create({
    name: 'Contract Creator',
    about: 'Creator for API contract tests.',
    photo: 'https://example.com/contract-creator.png',
    userId: creatorOwner._id,
    categories: ['contract'],
    price: 99,
    isOnline: false,
  });

  const response = await request(app)
    .get('/api/v1/creator')
    .set(authHeaders(requester.firebaseUid));

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.data.creators));
  assert.ok(Array.isArray(response.body.normalized.creators));
  assert.equal(typeof response.body.normalized.creators[0].id, 'string');
});

test('contract: /payment/packages and /payment/verify keep legacy + normalized response', async () => {
  const uid = 'uid-contract-payment';
  await User.create({
    firebaseUid: uid,
    email: 'contract-payment@local.test',
    role: 'user',
    coins: 0,
    freeTextUsed: 0,
  });

  const packagesResponse = await request(app)
    .get('/api/v1/payment/packages')
    .set(authHeaders(uid));

  assert.equal(packagesResponse.status, 200);
  assert.ok(Array.isArray(packagesResponse.body.data.packages));
  assert.ok(Array.isArray(packagesResponse.body.normalized.packages));
  assert.equal(
    packagesResponse.body.data.pricingTier,
    packagesResponse.body.normalized.pricingTier,
  );

  const createOrderResponse = await request(app)
    .post('/api/v1/payment/create-order')
    .set(authHeaders(uid))
    .send({ coins: 250 });

  assert.equal(createOrderResponse.status, 200);
  const orderId = createOrderResponse.body?.data?.orderId as string;
  assert.ok(orderId);

  const paymentId = 'pay_contract_1';
  const signature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET as string)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  const verifyResponse = await request(app)
    .post('/api/v1/payment/verify')
    .set(authHeaders(uid))
    .send({
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature,
    });

  assert.equal(verifyResponse.status, 200);
  assert.equal(verifyResponse.body.data.message, 'Payment verified successfully');
  assert.equal(verifyResponse.body.normalized.status, 'verified');
  assert.equal(verifyResponse.body.normalized.coinsAdded, verifyResponse.body.data.coinsAdded);
});

test('contract: /admin/system/drift endpoint remains backward compatible', async () => {
  const adminUid = 'uid-contract-admin';
  await User.create({
    firebaseUid: adminUid,
    email: 'admin-contract@local.test',
    role: 'admin',
    coins: 0,
    freeTextUsed: 0,
  });

  const response = await request(app)
    .get('/api/v1/admin/system/drift')
    .set(authHeaders(adminUid));

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.ok(response.body.data);
  assert.equal(typeof response.body.data.hasReport, 'boolean');
  assert.ok(response.body.data.authority);
});
