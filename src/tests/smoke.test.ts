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
  Authorization: 'Bearer smoke-test-token',
  'x-test-firebase-uid': firebaseUid,
  'x-test-email': `${firebaseUid}@smoke.local`,
});

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.FF_AUTH_BYPASS_FOR_TESTS = 'true';
  process.env.FF_PAYMENT_PROVIDER_MOCK = 'true';
  process.env.FF_BILLING_HTTP_MOCK = 'true';
  process.env.JWT_SECRET = 'smoke-test-jwt-secret-1234';
  process.env.CHECKOUT_SESSION_SECRET = 'smoke-test-checkout-secret-1234';
  process.env.RAZORPAY_KEY_SECRET = 'smoke-test-razorpay-secret';
  process.env.RAZORPAY_KEY_ID = 'rzp_test_smoke';

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

test('smoke: /auth/login returns success with authenticated user', async () => {
  const response = await request(app)
    .post('/api/v1/auth/login')
    .set(authHeaders('uid-smoke-auth'))
    .send({});

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
});

test('smoke: /payment/create-order and /payment/verify with mock provider', async () => {
  const firebaseUid = 'uid-smoke-payment';
  await User.create({
    firebaseUid,
    email: 'payment@smoke.local',
    role: 'user',
    coins: 100,
    freeTextUsed: 0,
  });

  const createOrderResponse = await request(app)
    .post('/api/v1/payment/create-order')
    .set(authHeaders(firebaseUid))
    .send({ coins: 250 });

  assert.equal(createOrderResponse.status, 200);
  assert.equal(createOrderResponse.body.success, true);

  const orderId = createOrderResponse.body?.data?.orderId as string;
  assert.ok(orderId);

  const paymentId = 'pay_smoke_1';
  const signature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET as string)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  const verifyResponse = await request(app)
    .post('/api/v1/payment/verify')
    .set(authHeaders(firebaseUid))
    .send({
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature,
    });

  assert.equal(verifyResponse.status, 200);
  assert.equal(verifyResponse.body.success, true);
  assert.ok(Number(verifyResponse.body.data.coinsAdded) > 0);
});

test('smoke: billing call-started and call-ended endpoints return success', async () => {
  const firebaseUid = 'uid-smoke-billing';
  await User.create({
    firebaseUid,
    email: 'billing@smoke.local',
    role: 'user',
    coins: 100,
    freeTextUsed: 0,
  });

  const callStarted = await request(app)
    .post('/api/v1/billing/call-started')
    .set(authHeaders(firebaseUid))
    .send({
      callId: 'call_smoke_1',
      creatorFirebaseUid: 'creator_smoke_uid',
      creatorMongoId: new mongoose.Types.ObjectId().toString(),
    });

  assert.equal(callStarted.status, 200);
  assert.equal(callStarted.body.success, true);

  const callEnded = await request(app)
    .post('/api/v1/billing/call-ended')
    .set(authHeaders(firebaseUid))
    .send({
      callId: 'call_smoke_1',
    });

  assert.equal(callEnded.status, 200);
  assert.equal(callEnded.body.success, true);
});

test('smoke: /creator list returns creator entries', async () => {
  const requesterUid = 'uid-smoke-creator-requester';
  const creatorOwnerUid = 'uid-smoke-creator-owner';

  const [requester, creatorOwner] = await Promise.all([
    User.create({
      firebaseUid: requesterUid,
      email: 'creator-requester@smoke.local',
      role: 'user',
      coins: 0,
      freeTextUsed: 0,
    }),
    User.create({
      firebaseUid: creatorOwnerUid,
      email: 'creator-owner@smoke.local',
      role: 'creator',
      coins: 0,
      freeTextUsed: 0,
    }),
  ]);

  await Creator.create({
    name: 'Smoke Creator',
    about: 'This is a smoke test creator profile.',
    photo: 'https://example.com/creator.png',
    userId: creatorOwner._id,
    categories: ['test'],
    price: 60,
    isOnline: false,
  });

  const response = await request(app)
    .get('/api/v1/creator')
    .set(authHeaders(requester.firebaseUid));

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.ok(Array.isArray(response.body?.data?.creators));
  assert.ok(response.body.data.creators.length >= 1);
});

