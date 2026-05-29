import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activeCallByUserKey,
  availabilityKey,
  creatorPresenceKey,
  resetRedisForTests,
  setRedisForTests,
} from '../../config/redis';
import { readCreatorPresenceState, transitionCreatorPresence } from '../availability/presence.service';
import { finalizeCreatorAvailabilityForCall, setCreatorFirebaseUidResolverForTests } from './creator-call-lock.service';
import { finalizeCallEnd, setCallFinalizationHooksForTests } from './call-finalization.service';
import { setIO } from '../../config/socket';

class InMemoryRedis {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<string | null> {
    const opts = args.map((v) => String(v).toUpperCase());
    const nx = opts.includes('NX');
    const xx = opts.includes('XX');
    const exists = this.store.has(key);
    if (nx && exists) return null;
    if (xx && !exists) return null;
    this.store.set(key, value);
    return 'OK';
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

  async expire(_key: string, _ttl: number): Promise<number> {
    return 1;
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
          const set = new Set<string>(existing ? JSON.parse(existing) as string[] : []);
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
          const set = new Set<string>(existing ? JSON.parse(existing) as string[] : []);
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

test('behavioral: finalizeCallEnd clears active slot and emits online creator:status', async () => {
  const redis = new InMemoryRedis();
  setRedisForTests(redis as any);
  setCreatorFirebaseUidResolverForTests(async (creatorUserId) =>
    creatorUserId === 'creator-user-1' ? 'creator-firebase-1' : null
  );

  const callId = 'call-behavior-1';
  const creatorFirebaseUid = 'creator-firebase-1';
  const activeSlotKey = activeCallByUserKey(creatorFirebaseUid);
  const precallSnapshotKey = `call:precall:availability:${callId}:${creatorFirebaseUid}`;
  await redis.setex(availabilityKey(creatorFirebaseUid), 120, 'online');
  await redis.setex(activeSlotKey, 7200, callId);
  await redis.setex(precallSnapshotKey, 7200, 'online');

  const socket = createMockIo();
  setIO(socket.io as any);
  await transitionCreatorPresence(socket.io as any, creatorFirebaseUid, 'CONNECTED', 'behavior.pre_finalize');
  const before = await readCreatorPresenceState(creatorFirebaseUid);
  assert.equal(before.state, 'busy', 'active slot must force busy before finalization');

  let fakeCallSaved = false;
  setCallFinalizationHooksForTests({
    loadCallForFinalization: async (inputCallId) =>
      inputCallId === callId
        ? {
            creatorUserId: { toString: () => 'creator-user-1' },
            status: 'accepted',
            isSettled: false,
            save: async () => {
              fakeCallSaved = true;
            },
          }
        : null,
    finalizeCallSession: async () => {
      return;
    },
    releaseCreatorCallLock: async () => {
      return;
    },
    finalizeCreatorAvailabilityForCall: finalizeCreatorAvailabilityForCall,
  });

  const result = await finalizeCallEnd(socket.io as any, callId, 'socket_call_ended');
  assert.equal(result.finalized, true);
  assert.equal(fakeCallSaved, true);

  const slotAfter = await redis.get(activeSlotKey);
  assert.equal(slotAfter, null, 'active slot must be removed after finalizeCallEnd');

  const after = await readCreatorPresenceState(creatorFirebaseUid);
  assert.equal(after.state, 'online', 'creator presence must derive to online after slot removal');

  const creatorStatusOnlineEmit = socket.emitted.find(
    (entry) =>
      entry.room === 'consumers' &&
      entry.event === 'creator:status' &&
      entry.payload?.creatorId === creatorFirebaseUid &&
      entry.payload?.status === 'online'
  );
  assert.ok(creatorStatusOnlineEmit, 'creator:status online emit must be broadcast');

  const persistedPresenceRaw = await redis.get(creatorPresenceKey(creatorFirebaseUid));
  assert.ok(persistedPresenceRaw, 'canonical creator presence must be written');
  const persistedPresence = JSON.parse(String(persistedPresenceRaw)) as { state: string };
  assert.equal(persistedPresence.state, 'online');

  setCallFinalizationHooksForTests({});
  setCreatorFirebaseUidResolverForTests(null);
  resetRedisForTests();
});
