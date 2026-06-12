import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activeCallByUserKey,
  availabilityKey,
  callSessionKey,
  callSessionTerminalKey,
  resetRedisForTests,
  setRedisForTests,
} from '../../config/redis';
import { readCreatorPresenceState, transitionCreatorPresence } from './presence.service';
import {
  clearCreatorActiveCallSlotIfStale,
  clearActiveCallSlotForReconciliationSweep,
  isCreatorActiveCallSlotLive,
  setIsCreatorActiveCallSlotLiveResolverForTests,
  setResolveCallRecordForTests,
  ACTIVE_CALL_SLOT_TTL_SECONDS,
  RINGING_SLOT_GRACE_SECONDS,
} from './creator-active-call-slot.service';
import { setIO } from '../../config/socket';

class InMemoryRedis {
  private store = new Map<string, string>();
  private expiries = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    this.evictExpired(key);
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  private evictExpired(key: string): void {
    const expiresAt = this.expiries.get(key);
    if (expiresAt != null && Date.now() >= expiresAt) {
      this.store.delete(key);
      this.expiries.delete(key);
    }
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<'OK'> {
    this.store.set(key, value);
    const exIndex = args.findIndex((v) => String(v).toUpperCase() === 'EX');
    if (exIndex >= 0 && args[exIndex + 1] != null) {
      const ttlSeconds = Number(args[exIndex + 1]);
      if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
        this.expiries.set(key, Date.now() + ttlSeconds * 1000);
      }
    }
    return 'OK';
  }

  async ttl(key: string): Promise<number> {
    this.evictExpired(key);
    if (!this.store.has(key)) return -2;
    const expiresAt = this.expiries.get(key);
    if (expiresAt == null) return -1;
    return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  }

  async setex(key: string, ttl: number, value: string): Promise<'OK'> {
    return this.set(key, value, 'EX', ttl);
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.store.delete(key)) removed += 1;
    }
    return removed;
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    return keys.map((k) => (this.store.has(k) ? this.store.get(k)! : null));
  }

  multi(): {
    setex: (key: string, ttl: number, value: string) => any;
    exec: () => Promise<Array<[null, 'OK']>>;
  } {
    const ops: Array<() => void> = [];
    const txn = {
      setex: (key: string, _ttl: number, value: string) => {
        ops.push(() => this.store.set(key, value));
        return txn;
      },
      exec: async () => {
        ops.forEach((op) => op());
        return ops.map(() => [null, 'OK'] as [null, 'OK']);
      },
    };
    return txn;
  }

  pipeline(): {
    sadd: (key: string, value: string) => any;
    srem: (key: string, value: string) => any;
    del: (...keys: string[]) => any;
    exec: () => Promise<Array<[null, number]>>;
  } {
    const ops: Array<() => number> = [];
    const txn = {
      sadd: (key: string, value: string) => {
        ops.push(() => {
          const existing = this.store.get(key);
          const set = new Set<string>(existing ? (JSON.parse(existing) as string[]) : []);
          const before = set.size;
          set.add(value);
          this.store.set(key, JSON.stringify(Array.from(set)));
          return set.size > before ? 1 : 0;
        });
        return txn;
      },
      srem: (key: string, value: string) => {
        ops.push(() => {
          const existing = this.store.get(key);
          const set = new Set<string>(existing ? (JSON.parse(existing) as string[]) : []);
          const removed = set.delete(value);
          this.store.set(key, JSON.stringify(Array.from(set)));
          return removed ? 1 : 0;
        });
        return txn;
      },
      del: (...keys: string[]) => {
        ops.push(() => {
          let count = 0;
          for (const key of keys) {
            if (this.store.delete(key)) count += 1;
          }
          return count;
        });
        return txn;
      },
      exec: async () => ops.map((op) => [null, op()] as [null, number]),
    };
    return txn;
  }
}

function createMockIo() {
  return {
    to() {
      return { emit() {} };
    },
  };
}

test('behavioral: read path is read-only and does not clear orphan active-call slot', async () => {
  const redis = new InMemoryRedis();
  setRedisForTests(redis as any);
  setIO(createMockIo() as any);
  setIsCreatorActiveCallSlotLiveResolverForTests(async () => false);

  const creatorFirebaseUid = 'creator-read-only-slot';
  const staleCallId = 'call-ended-hours-ago';
  await redis.setex(availabilityKey(creatorFirebaseUid), 120, 'online');
  await redis.setex(activeCallByUserKey(creatorFirebaseUid), 7200, staleCallId);

  const state = await readCreatorPresenceState(creatorFirebaseUid);
  assert.equal(state.state, 'on_call', 'reads derive on_call from slot without side effects');

  const slot = await redis.get(activeCallByUserKey(creatorFirebaseUid));
  assert.equal(slot, staleCallId, 'read path must not delete the slot');

  setIsCreatorActiveCallSlotLiveResolverForTests(null);
  resetRedisForTests();
});

test('behavioral: explicit stale cleanup still clears orphan active-call slot', async () => {
  const redis = new InMemoryRedis();
  setRedisForTests(redis as any);
  setIO(createMockIo() as any);
  setIsCreatorActiveCallSlotLiveResolverForTests(async () => false);

  const creatorFirebaseUid = 'creator-stale-slot';
  const staleCallId = 'call-ended-hours-ago';
  await redis.setex(availabilityKey(creatorFirebaseUid), 120, 'online');
  await redis.setex(activeCallByUserKey(creatorFirebaseUid), 7200, staleCallId);

  const cleared = await clearCreatorActiveCallSlotIfStale(creatorFirebaseUid, {
    source: 'test.stale_slot',
  });
  assert.equal(cleared.cleared, true, 'orphan slot without session should be cleared');

  const state = await readCreatorPresenceState(creatorFirebaseUid);
  assert.equal(state.state, 'online');

  setIsCreatorActiveCallSlotLiveResolverForTests(null);
  setIsCreatorActiveCallSlotLiveResolverForTests(null);
  resetRedisForTests();
});

test('behavioral: FORCE_OFFLINE transition clears active-call slot', async () => {
  const redis = new InMemoryRedis();
  setRedisForTests(redis as any);
  const io = createMockIo();
  setIO(io as any);

  const creatorFirebaseUid = 'creator-force-offline';
  await redis.setex(availabilityKey(creatorFirebaseUid), 120, 'online');
  await redis.setex(activeCallByUserKey(creatorFirebaseUid), 7200, 'call-stale-1');

  await transitionCreatorPresence(io as any, creatorFirebaseUid, 'FORCE_OFFLINE', 'test.force_offline');

  const slot = await redis.get(activeCallByUserKey(creatorFirebaseUid));
  assert.equal(slot, null);
  const state = await readCreatorPresenceState(creatorFirebaseUid);
  assert.equal(state.state, 'offline');

  setIsCreatorActiveCallSlotLiveResolverForTests(null);
  resetRedisForTests();
});

test('behavioral: ringing slot is live when precall snapshot exists without Mongo call', async () => {
  const redis = new InMemoryRedis();
  setRedisForTests(redis as any);
  setResolveCallRecordForTests(async () => null);

  const callId = 'call-ringing-precall';
  const creatorUid = 'creator-ringing-precall';
  await redis.set(activeCallByUserKey(creatorUid), callId, 'EX', 7200);
  await redis.setex(`call:precall:availability:${callId}:${creatorUid}`, 7200, 'online');

  const live = await isCreatorActiveCallSlotLive(callId, creatorUid);
  assert.equal(live, true);

  setResolveCallRecordForTests(null);
  resetRedisForTests();
});

test('behavioral: fresh ringing slot is live via TTL grace when Mongo call is missing', async () => {
  const redis = new InMemoryRedis();
  setRedisForTests(redis as any);
  setResolveCallRecordForTests(async () => null);

  const callId = 'call-ringing-ttl-grace';
  const creatorUid = 'creator-ringing-ttl';
  await redis.set(activeCallByUserKey(creatorUid), callId, 'EX', 7200);

  const live = await isCreatorActiveCallSlotLive(callId, creatorUid);
  assert.equal(live, true);

  setResolveCallRecordForTests(null);
  resetRedisForTests();
});

test('behavioral: reconciliation sweep skips slots within grace window', async () => {
  const redis = new InMemoryRedis();
  setRedisForTests(redis as any);
  setResolveCallRecordForTests(async () => null);

  const callId = 'call-sweep-grace';
  const creatorUid = 'creator-sweep-grace';
  await redis.set(activeCallByUserKey(creatorUid), callId, 'EX', ACTIVE_CALL_SLOT_TTL_SECONDS);

  const result = await clearActiveCallSlotForReconciliationSweep(creatorUid, 'test.sweep');
  assert.equal(result.cleared, false);
  assert.equal(result.reason, 'within_sweep_grace_window');
  assert.ok((result.slotAgeSeconds ?? 0) < RINGING_SLOT_GRACE_SECONDS + 120);

  setResolveCallRecordForTests(null);
  resetRedisForTests();
});

test('behavioral: reconciliation sweep clears aged orphan without Mongo call', async () => {
  const redis = new InMemoryRedis();
  setRedisForTests(redis as any);
  setResolveCallRecordForTests(async () => null);

  const callId = 'call-sweep-orphan';
  const creatorUid = 'creator-sweep-orphan';
  const agedTtl = Math.max(1, ACTIVE_CALL_SLOT_TTL_SECONDS - RINGING_SLOT_GRACE_SECONDS - 120);
  await redis.set(activeCallByUserKey(creatorUid), callId, 'EX', agedTtl);
  await redis.setex(`call:precall:availability:${callId}:${creatorUid}`, 7200, 'online');

  const liveDefault = await isCreatorActiveCallSlotLive(callId, creatorUid, 'default');
  assert.equal(liveDefault, true, 'precall grace protects slot during default liveness check');

  const result = await clearActiveCallSlotForReconciliationSweep(creatorUid, 'test.sweep');
  assert.equal(result.cleared, true);
  assert.equal(result.reason, 'reconciliation_sweep_orphan');

  const slot = await redis.get(activeCallByUserKey(creatorUid));
  assert.equal(slot, null);

  setResolveCallRecordForTests(null);
  resetRedisForTests();
});

test('behavioral: active-call slot is live when slot owner matches payer (userFirebaseUid)', async () => {
  const redis = new InMemoryRedis();
  setRedisForTests(redis as any);

  const callId = 'call-live-1';
  const payerUid = 'payer-uid-1';
  const creatorUid = 'creator-uid-1';
  await redis.setex(
    callSessionKey(callId),
    7200,
    JSON.stringify({
      userFirebaseUid: payerUid,
      creatorFirebaseUid: creatorUid,
      lifecycleState: 'ACTIVE',
      totalDeductedMicros: 123,
    })
  );

  const live = await isCreatorActiveCallSlotLive(callId, payerUid);
  assert.equal(live, true);

  setIsCreatorActiveCallSlotLiveResolverForTests(null);
  resetRedisForTests();
});

test('behavioral: active-call slot is live when slot owner matches creator (creatorFirebaseUid)', async () => {
  const redis = new InMemoryRedis();
  setRedisForTests(redis as any);

  const callId = 'call-live-2';
  const payerUid = 'payer-uid-2';
  const creatorUid = 'creator-uid-2';
  await redis.setex(
    callSessionKey(callId),
    7200,
    JSON.stringify({
      userFirebaseUid: payerUid,
      creatorFirebaseUid: creatorUid,
      lifecycleState: 'ACTIVE',
    })
  );

  const live = await isCreatorActiveCallSlotLive(callId, creatorUid);
  assert.equal(live, true);

  setIsCreatorActiveCallSlotLiveResolverForTests(null);
  resetRedisForTests();
});

test('behavioral: active-call slot is not live when slot owner matches neither party', async () => {
  const redis = new InMemoryRedis();
  setRedisForTests(redis as any);

  const callId = 'call-live-3';
  await redis.setex(
    callSessionKey(callId),
    7200,
    JSON.stringify({
      userFirebaseUid: 'payer-uid-3',
      creatorFirebaseUid: 'creator-uid-3',
      lifecycleState: 'ACTIVE',
    })
  );

  const live = await isCreatorActiveCallSlotLive(callId, 'random-other-uid');
  assert.equal(live, false);

  setIsCreatorActiveCallSlotLiveResolverForTests(null);
  resetRedisForTests();
});

test('behavioral: stale-only clear leaves live call slot intact', async () => {
  const redis = new InMemoryRedis();
  setRedisForTests(redis as any);

  const creatorFirebaseUid = 'creator-live-slot';
  const liveCallId = 'call-live-toggle';
  await redis.setex(activeCallByUserKey(creatorFirebaseUid), 7200, liveCallId);

  setIsCreatorActiveCallSlotLiveResolverForTests(async () => true);

  const result = await clearCreatorActiveCallSlotIfStale(creatorFirebaseUid, {
    source: 'test.clear_stuck_call_live',
  });
  assert.equal(result.cleared, false);
  assert.equal(result.reason, 'slot_still_live');
  const slot = await redis.get(activeCallByUserKey(creatorFirebaseUid));
  assert.equal(slot, liveCallId);

  setIsCreatorActiveCallSlotLiveResolverForTests(null);
  resetRedisForTests();
});

test('behavioral: active-call slot is not live when terminal marker exists', async () => {
  const redis = new InMemoryRedis();
  setRedisForTests(redis as any);

  const callId = 'call-live-4';
  await redis.setex(callSessionTerminalKey(callId), 7200, '1');

  const live = await isCreatorActiveCallSlotLive(callId, 'any-uid');
  assert.equal(live, false);

  setIsCreatorActiveCallSlotLiveResolverForTests(null);
  resetRedisForTests();
});
