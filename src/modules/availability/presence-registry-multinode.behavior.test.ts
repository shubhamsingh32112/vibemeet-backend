import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';

import { resetRedisForTests, setRedisForTests } from '../../config/redis';
import {
  cancelDisconnectGrace,
  hasAnySocket,
  isHeartbeatLeaseHolder,
  registerSocket,
  startDisconnectGrace,
  tryAcquireHeartbeatLease,
  unregisterSocket,
} from './presence-socket-registry.service';

type HashStore = Map<string, Map<string, string>>;

class MultinodeRegistryRedis {
  private strings = new Map<string, string>();
  private hashes: HashStore = new Map();

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    mode?: string,
    _duration?: number | string,
    nxOrXx?: string
  ): Promise<'OK' | null> {
    if (mode === 'PX' && nxOrXx === 'NX') {
      if (this.strings.has(key)) return null;
      this.strings.set(key, value);
      return 'OK';
    }
    if (mode === 'PX') {
      this.strings.set(key, value);
      return 'OK';
    }
    this.strings.set(key, value);
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) n++;
      if (this.hashes.delete(key)) n++;
    }
    return n;
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    const h = this.hashes.get(key)!;
    const isNew = !h.has(field);
    h.set(field, value);
    return isNew ? 1 : 0;
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hlen(key: string): Promise<number> {
    return this.hashes.get(key)?.size ?? 0;
  }

  async hdel(key: string, field: string): Promise<number> {
    return this.hashes.get(key)?.delete(field) ? 1 : 0;
  }

  async expire(key: string, _ttl: number): Promise<number> {
    return this.hashes.has(key) || this.strings.has(key) ? 1 : 0;
  }

  async eval(script: string, numKeys: number, ...args: string[]): Promise<unknown> {
    const keys = args.slice(0, numKeys);
    const argv = args.slice(numKeys);
    if (script.includes("redis.call('HSET', socketsKey")) {
      const [socketId, instanceId, role, connectedAt, ttl] = argv;
      const countBefore = await this.hlen(keys[0]);
      const existing = await this.hget(keys[0], socketId);
      let version = 1;
      if (existing) {
        version = JSON.parse(existing).version + 1;
      }
      await this.hset(
        keys[0],
        socketId,
        JSON.stringify({ instanceId, version, connectedAt: Number(connectedAt), role })
      );
      await this.expire(keys[0], Number(ttl));
      return [await this.hlen(keys[0]), version, countBefore === 0 ? 1 : 0];
    }
    if (script.includes("redis.call('HDEL', socketsKey")) {
      const [socketId, version, ttl] = argv;
      const existing = await this.hget(keys[0], socketId);
      if (!existing) return [0, await this.hlen(keys[0])];
      if (JSON.parse(existing).version !== Number(version)) {
        return [0, await this.hlen(keys[0])];
      }
      await this.hdel(keys[0], socketId);
      const count = await this.hlen(keys[0]);
      if (count === 0) await this.del(keys[0]);
      else await this.expire(keys[0], Number(ttl));
      return [1, count];
    }
    if (script.includes('hbKey')) {
      const [instanceId] = argv;
      if ((await this.get(keys[0])) !== instanceId) return 0;
      await this.set(keys[0], instanceId, 'PX', Number(argv[1]));
      if ((await this.hlen(keys[1])) > 0) await this.expire(keys[1], Number(argv[2]));
      return 1;
    }
    if (script.includes('graceKey')) {
      if ((await this.get(keys[0])) === argv[0]) {
        await this.del(keys[0]);
        return 1;
      }
      return 0;
    }
    throw new Error('unhandled eval');
  }
}

afterEach(() => {
  resetRedisForTests();
  delete process.env.PRESENCE_INSTANCE_ID;
});

test('node B sees sockets registered on node A', async () => {
  const redis = new MultinodeRegistryRedis();
  setRedisForTests(redis as any);
  process.env.PRESENCE_INSTANCE_ID = 'node-a';

  const uid = 'creator-mn-1';
  await registerSocket(uid, 'sock-a', 'creator');

  process.env.PRESENCE_INSTANCE_ID = 'node-b';
  assert.equal(await hasAnySocket(uid), true);
});

test('reconnect on node B before grace elapses keeps creator online', async () => {
  const redis = new MultinodeRegistryRedis();
  setRedisForTests(redis as any);
  const uid = 'creator-mn-grace';

  process.env.PRESENCE_INSTANCE_ID = 'node-a';
  const reg = await registerSocket(uid, 'sock-a', 'creator');
  await unregisterSocket(uid, 'sock-a', reg.version);
  const { token } = await startDisconnectGrace(uid);

  process.env.PRESENCE_INSTANCE_ID = 'node-b';
  await registerSocket(uid, 'sock-b', 'creator');
  assert.equal(await hasAnySocket(uid), true);
  assert.equal(await cancelDisconnectGrace(uid, token), true);
});

test('lease split-brain: non-holder cannot renew', async () => {
  const redis = new MultinodeRegistryRedis();
  setRedisForTests(redis as any);
  const uid = 'creator-lease-mn';

  process.env.PRESENCE_INSTANCE_ID = 'node-a';
  await registerSocket(uid, 'sock', 'creator');
  assert.equal(await tryAcquireHeartbeatLease(uid), true);

  process.env.PRESENCE_INSTANCE_ID = 'node-b';
  assert.equal(await isHeartbeatLeaseHolder(uid), false);
  assert.equal(await tryAcquireHeartbeatLease(uid), false);
});
