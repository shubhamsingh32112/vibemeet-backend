import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activeCallByUserKey,
  availabilityKey,
  resetRedisForTests,
  setRedisForTests,
} from '../../config/redis';
import { readCreatorPresenceState, transitionCreatorPresence } from './presence.service';
import {
  clearCreatorActiveCallSlotIfStale,
  setIsCreatorActiveCallSlotLiveResolverForTests,
} from './creator-active-call-slot.service';
import { setIO } from '../../config/socket';

class InMemoryRedis {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  async setex(key: string, _ttl: number, value: string): Promise<'OK'> {
    this.store.set(key, value);
    return 'OK';
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

test('behavioral: read path clears orphan active-call slot so creator is not stuck on_call', async () => {
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
