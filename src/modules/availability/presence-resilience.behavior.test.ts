import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  availabilityKey,
  activeCallByUserKey,
  creatorPresenceKey,
  resetRedisForTests,
  setRedisForTests,
} from '../../config/redis';
import { getBatchCreatorPresence, transitionCreatorPresence, creatorPresenceMetaKey } from './presence.service';
import { setIO } from '../../config/socket';
import { monitoring } from '../../utils/monitoring';
import { featureFlags } from '../../config/feature-flags';

class FlakyInMemoryRedis {
  private store = new Map<string, string>();
  private failNextExec = false;

  failNextTransitionWrite(): void {
    this.failNextExec = true;
  }

  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  async setex(key: string, _ttl: number, value: string): Promise<'OK'> {
    this.store.set(key, value);
    return 'OK';
  }

  async set(key: string, value: string, ..._args: Array<string | number>): Promise<'OK' | null> {
    this.store.set(key, value);
    return 'OK';
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    return keys.map((key) => (this.store.has(key) ? this.store.get(key)! : null));
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
          const raw = this.store.get(key);
          const set = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
          const before = set.size;
          set.add(value);
          this.store.set(key, JSON.stringify(Array.from(set)));
          return set.size > before ? 1 : 0;
        });
        return txn;
      },
      srem: (key: string, value: string) => {
        ops.push(() => {
          const raw = this.store.get(key);
          const set = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
          const removed = set.delete(value);
          this.store.set(key, JSON.stringify(Array.from(set)));
          return removed ? 1 : 0;
        });
        return txn;
      },
      del: (...keys: string[]) => {
        ops.push(() => {
          let removed = 0;
          for (const key of keys) {
            if (this.store.delete(key)) removed += 1;
          }
          return removed;
        });
        return txn;
      },
      exec: async () => ops.map((op) => [null, op()] as [null, number]),
    };
    return txn;
  }

  multi(): {
    setex: (key: string, ttl: number, value: string) => any;
    exec: () => Promise<Array<[Error | null, 'OK' | null]>>;
  } {
    const ops: Array<{ key: string; value: string }> = [];
    const txn = {
      setex: (key: string, _ttl: number, value: string) => {
        ops.push({ key, value });
        return txn;
      },
      exec: async () => {
        if (this.failNextExec) {
          this.failNextExec = false;
          return ops.map(() => [new Error('synthetic redis multi failure'), null] as [Error, null]);
        }
        for (const op of ops) {
          this.store.set(op.key, op.value);
        }
        return ops.map(() => [null, 'OK'] as [null, 'OK']);
      },
    };
    return txn;
  }
}

function createMockIo() {
  const emitted: Array<{ room: string; event: string; payload: any }> = [];
  return {
    emitted,
    io: {
      to(room: string) {
        return {
          emit(event: string, payload: any) {
            emitted.push({ room, event, payload });
          },
        };
      },
    },
  };
}

test('presence batch drops invalid uid candidates and keeps valid records', async () => {
  monitoring.clear();
  const redis = new FlakyInMemoryRedis();
  setRedisForTests(redis as any);
  await redis.setex(availabilityKey('valid_uid_12345'), 180, 'online');
  await redis.setex(creatorPresenceMetaKey('valid_uid_12345'), 180, JSON.stringify({
    base: 'online',
    updatedAt: Date.now(),
    source: 'test.seed',
    version: 1,
  }));

  const result = await getBatchCreatorPresence(['valid_uid_12345', 'bad uid with space']);
  assert.equal(Object.keys(result).length, 1);
  assert.equal(result.valid_uid_12345?.state, 'online');

  resetRedisForTests();
});

test('presence batch falls back when canonical meta payload is invalid', async () => {
  monitoring.clear();
  const redis = new FlakyInMemoryRedis();
  setRedisForTests(redis as any);
  await redis.setex(availabilityKey('meta_invalid_uid_1'), 180, 'online');
  await redis.setex(creatorPresenceMetaKey('meta_invalid_uid_1'), 180, '{invalid-json');
  await redis.setex(activeCallByUserKey('meta_invalid_uid_1'), 180, '');

  const result = await getBatchCreatorPresence(['meta_invalid_uid_1']);
  assert.equal(result.meta_invalid_uid_1?.state, 'online');
  assert.ok(result.meta_invalid_uid_1?.version >= 0);

  resetRedisForTests();
});

test('transition retries once when first redis multi fails', async () => {
  monitoring.clear();
  const redis = new FlakyInMemoryRedis();
  setRedisForTests(redis as any);
  const socket = createMockIo();
  setIO(socket.io as any);
  redis.failNextTransitionWrite();

  const record = await transitionCreatorPresence(
    socket.io as any,
    'retry_uid_12345',
    'CONNECTED',
    'test.retry_behavior'
  );

  assert.equal(record.state, 'online');
  const persisted = await redis.get(creatorPresenceKey('retry_uid_12345'));
  assert.ok(persisted, 'presence should be persisted after retry succeeds');

  resetRedisForTests();
});

test('canonical missing rate excludes offline no-key rows from denominator', async () => {
  monitoring.clear();
  const redis = new FlakyInMemoryRedis();
  setRedisForTests(redis as any);
  await redis.setex(availabilityKey('expected_uid_1'), 180, 'online');

  const result = await getBatchCreatorPresence(['expected_uid_1', 'offline_absent_uid_2']);
  assert.equal(result.expected_uid_1?.state, 'online');
  assert.equal(result.offline_absent_uid_2?.state, 'offline');

  const metrics = monitoring.getMetricsSummary().byName;
  assert.equal(
    metrics['call.presence.creator_batch_canonical_missing_rate']?.avg,
    1,
    'expected-only denominator should produce 1.0 missing rate'
  );
  assert.equal(
    metrics['call.presence.creator_meta_missing_any_rate']?.avg,
    1,
    'diagnostic any-rate should reflect both rows missing meta'
  );

  resetRedisForTests();
});

test('uid enforce mode drops invalid entries but keeps valid lookups', async () => {
  monitoring.clear();
  const redis = new FlakyInMemoryRedis();
  setRedisForTests(redis as any);
  await redis.setex(availabilityKey('valid_uid_enforce_1'), 180, 'online');
  await redis.setex(creatorPresenceMetaKey('valid_uid_enforce_1'), 180, JSON.stringify({
    base: 'online',
    updatedAt: Date.now(),
    source: 'test.enforce',
    version: 3,
  }));
  const previous = featureFlags.creatorPresenceUidContractEnforced;
  featureFlags.creatorPresenceUidContractEnforced = true;
  try {
    const result = await getBatchCreatorPresence(['valid_uid_enforce_1', 'bad uid']);
    assert.equal(Object.keys(result).length, 1);
    assert.equal(result.valid_uid_enforce_1?.state, 'online');
  } finally {
    featureFlags.creatorPresenceUidContractEnforced = previous;
    resetRedisForTests();
  }
});
