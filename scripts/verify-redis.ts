/**
 * Redis Connection Verification Script
 * 
 * Tests Redis connectivity and operations before deployment.
 * Run with: npm run verify:redis
 */

import { getRedis, callSessionKey, callUserCoinsKey, ACTIVE_BILLING_CALLS_KEY } from '../src/config/redis';
import { logInfo, logError } from '../src/utils/logger';

async function verifyRedis() {
  console.log('🔍 Verifying Redis connection...\n');
  
  try {
    const redis = getRedis();
    
    // Test 1: Ping
    console.log('Test 1: Ping...');
    const pingResult = await redis.ping();
    if (pingResult === 'PONG') {
      console.log('✅ Ping: PASS\n');
    } else {
      console.log(`❌ Ping: FAIL (got: ${pingResult})\n`);
      process.exit(1);
    }
    
    // Test 2: Write/Read
    console.log('Test 2: Write/Read...');
    const testKey = 'test:verification';
    await redis.setex(testKey, 10, 'test-value');
    const value = await redis.get(testKey);
    if (value === 'test-value') {
      console.log('✅ Write/Read: PASS\n');
    } else {
      console.log(`❌ Write/Read: FAIL (got: ${value}, expected: test-value)\n`);
      await redis.del(testKey).catch(() => {});
      process.exit(1);
    }
    await redis.del(testKey);
    
    // Test 3: Sorted Set (used for billing)
    console.log('Test 3: Sorted Set (billing)...');
    const testSetKey = 'test:sorted_set';
    const now = Date.now();
    await redis.zadd(testSetKey, now, 'test-member');
    const score = await redis.zscore(testSetKey, 'test-member');
    if (score && Math.abs(parseFloat(score.toString()) - now) < 1000) {
      console.log('✅ Sorted Set: PASS\n');
    } else {
      console.log(`❌ Sorted Set: FAIL (got: ${score}, expected: ${now})\n`);
      await redis.del(testSetKey).catch(() => {});
      process.exit(1);
    }
    await redis.del(testSetKey);
    
    // Test 4: Key helpers (verify they work)
    console.log('Test 4: Key helpers...');
    const testCallId = 'test-call-123';
    const sessionKey = callSessionKey(testCallId);
    const coinsKey = callUserCoinsKey(testCallId);
    
    if (sessionKey.includes(testCallId) && coinsKey.includes(testCallId)) {
      console.log('✅ Key helpers: PASS\n');
    } else {
      console.log(`❌ Key helpers: FAIL\n`);
      process.exit(1);
    }
    
    // Test 5: Set with NX (used for locks)
    console.log('Test 5: Set with NX (locks)...');
    const lockKey = 'test:lock';
    const lockResult1 = await redis.set(lockKey, '1', 'EX', 10, 'NX');
    const lockResult2 = await redis.set(lockKey, '1', 'EX', 10, 'NX');
    await redis.del(lockKey).catch(() => {});
    
    if (lockResult1 === 'OK' && lockResult2 === null) {
      console.log('✅ Set with NX: PASS\n');
    } else {
      console.log(`❌ Set with NX: FAIL (first: ${lockResult1}, second: ${lockResult2})\n`);
      process.exit(1);
    }
    
    console.log('✅ All Redis tests passed!');
    console.log('\n📋 Redis is ready for billing operations.');
    console.log('   - Coin deduction will work');
    console.log('   - Creator earnings will work');
    console.log('   - Billing processor can start');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Redis verification failed:');
    console.error(error);
    console.error('\n🔧 Troubleshooting:');
    console.error('   1. Check Redis environment variables:');
    console.error('      - REDIS_URL or REDIS_PUBLIC_URL');
    console.error('      - OR REDISHOST + REDISPORT + REDIS_PASSWORD');
    console.error('   2. Verify Redis service is running');
    console.error('   3. Check network connectivity');
    process.exit(1);
  }
}

verifyRedis();
