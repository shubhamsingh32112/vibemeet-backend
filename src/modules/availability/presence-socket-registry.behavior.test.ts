import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { randomUUID } from 'crypto';

import {
  presenceHbOwnerKey,
  presenceSocketsKey,
  resetRedisForTests,
  setRedisForTests,
} from '../../config/redis';
import {
  cancelDisconnectGrace,
  getSocketCount,
  hasAnySocket,
  isDisconnectGraceActive,
  isHeartbeatLeaseHolder,
  registerSocket,
  releaseHeartbeatLease,
  renewHeartbeatLease,
  startDisconnectGrace,
  tryAcquireHeartbeatLease,
  unregisterSocket,
} from './presence-socket-registry.service';

type HashStore = Map<string, Map<string, string>>;

class RegistryInMemoryRedis {
  private strings = new Map<string, string>();
  private hashes: HashStore = new Map();
  private expiries = new Map<string, number>();
  private pxExpiries = new Map<string, number>();

  private isExpired(key: string): boolean {
    const px = this.pxExpiries.get(key);
    if (px != null && Date.now() > px) {
      this.strings.delete(key);
      this.pxExpiries.delete(key);
      return true;
    }
    const ex = this.expiries.get(key);
    if (ex != null && Date.now() / 1000 > ex) {
      this.strings.delete(key);
      this.hashes.delete(key);
      this.expiries.delete(key);
      return true;
    }
    return false;
  }

  private hashKey(key: string): Map<string, string> {
    if (this.isExpired(key)) this.hashes.delete(key);
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    return this.hashes.get(key)!;
  }

  async get(key: string): Promise<string | null> {
    if (this.isExpired(key)) return null;
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
      if (this.isExpired(key)) this.strings.delete(key);
      if (this.strings.has(key)) return null;
      this.strings.set(key, value);
      this.pxExpiries.set(key, Date.now() + Number(_duration));
      return 'OK';
    }
    if (mode === 'PX') {
      this.strings.set(key, value);
      this.pxExpiries.set(key, Date.now() + Number(_duration));
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
      this.expiries.delete(key);
      this.pxExpiries.delete(key);
    }
    return n;
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    const h = this.hashKey(key);
    const isNew = !h.has(field);
    h.set(field, value);
    return isNew ? 1 : 0;
  }

  async hget(key: string, field: string): Promise<string | null> {
    if (this.isExpired(key)) return null;
    return this.hashKey(key).get(field) ?? null;
  }

  async hlen(key: string): Promise<number> {
    if (this.isExpired(key)) return 0;
    return this.hashKey(key).size;
  }

  async hdel(key: string, field: string): Promise<number> {
    if (this.isExpired(key)) return 0;
    return this.hashKey(key).delete(field) ? 1 : 0;
  }

  async hkeys(key: string): Promise<string[]> {
    if (this.isExpired(key)) return [];
    return Array.from(this.hashKey(key).keys());
  }

  async expire(key: string, ttl: number): Promise<number> {
    if (!this.hashes.has(key) && !this.strings.has(key)) return 0;
    this.expiries.set(key, Date.now() / 1000 + ttl);
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const ex = this.expiries.get(key);
    if (ex == null) return -1;
    return Math.max(0, Math.floor(ex - Date.now() / 1000));
  }

  async eval(script: string, numKeys: number, ...args: string[]): Promise<unknown> {
    const keys = args.slice(0, numKeys);
    const argv = args.slice(numKeys);

    if (script.includes("redis.call('HSET', socketsKey")) {
      const socketsKey = keys[0];
      const [socketId, instanceId, role, connectedAt, ttl] = argv;
      const countBefore = await this.hlen(socketsKey);
      const existing = await this.hget(socketsKey, socketId);
      let version = 1;
      if (existing) {
        const record = JSON.parse(existing);
        version = (record.version ?? 1) + 1;
      }
      const recordJson = JSON.stringify({
        instanceId,
        version,
        connectedAt: Number(connectedAt),
        role,
      });
      await this.hset(socketsKey, socketId, recordJson);
      await this.expire(socketsKey, Number(ttl));
      const count = await this.hlen(socketsKey);
      return [count, version, countBefore === 0 ? 1 : 0];
    }

    if (script.includes("redis.call('HDEL', socketsKey")) {
      const socketsKey = keys[0];
      const [socketId, version, ttl] = argv;
      const existing = await this.hget(socketsKey, socketId);
      if (!existing) return [0, await this.hlen(socketsKey)];
      const record = JSON.parse(existing);
      if (Number(record.version) !== Number(version)) {
        return [0, await this.hlen(socketsKey)];
      }
      await this.hdel(socketsKey, socketId);
      const count = await this.hlen(socketsKey);
      if (count === 0) {
        await this.del(socketsKey);
      } else {
        await this.expire(socketsKey, Number(ttl));
      }
      return [1, count];
    }

    if (script.includes('RENEW_HEARTBEAT') || script.includes("redis.call('SET', hbKey")) {
      const [hbKey, socketsKey] = keys;
      const [instanceId, leaseTtlMs, registryTtl] = argv;
      const current = await this.get(hbKey);
      if (current !== instanceId) return 0;
      await this.set(hbKey, instanceId, 'PX', Number(leaseTtlMs));
      const count = await this.hlen(socketsKey);
      if (count > 0) await this.expire(socketsKey, Number(registryTtl));
      return 1;
    }

    if (script.includes('graceKey')) {
      const graceKey = keys[0];
      const [token] = argv;
      const value = await this.get(graceKey);
      if (value === token) {
        await this.del(graceKey);
        return 1;
      }
      return 0;
    }

    throw new Error('Unhandled eval script in test mock');
  }
}

afterEach(() => {
  resetRedisForTests();
  delete process.env.PRESENCE_INSTANCE_ID;
});

test('registerSocket increments count and returns isFirst', async () => {
  const redis = new RegistryInMemoryRedis();
  setRedisForTests(redis as any);
  process.env.PRESENCE_INSTANCE_ID = 'node-a';

  const uid = 'creator-1';
  const r1 = await registerSocket(uid, 'sock-1', 'creator');
  assert.equal(r1.count, 1);
  assert.equal(r1.isFirst, true);
  assert.equal(r1.version, 1);

  const r2 = await registerSocket(uid, 'sock-2', 'creator');
  assert.equal(r2.count, 2);
  assert.equal(r2.isFirst, false);

  assert.equal(await getSocketCount(uid), 2);
  assert.equal(await hasAnySocket(uid), true);
});

test('unregisterSocket rejects stale version', async () => {
  const redis = new RegistryInMemoryRedis();
  setRedisForTests(redis as any);

  const uid = 'creator-2';
  const reg = await registerSocket(uid, 'sock-1', 'creator');
  const stale = await unregisterSocket(uid, 'sock-1', reg.version - 1);
  assert.equal(stale.removed, false);
  assert.equal(stale.count, 1);

  const ok = await unregisterSocket(uid, 'sock-1', reg.version);
  assert.equal(ok.removed, true);
  assert.equal(ok.count, 0);
  assert.equal(await hasAnySocket(uid), false);
});

test('last unregister deletes hash key', async () => {
  const redis = new RegistryInMemoryRedis();
  setRedisForTests(redis as any);

  const uid = 'creator-3';
  const reg = await registerSocket(uid, 'sock-only', 'creator');
  await unregisterSocket(uid, 'sock-only', reg.version);
  assert.equal(await redis.hlen(presenceSocketsKey(uid)), 0);
});

test('heartbeat lease acquire renew and release', async () => {
  const redis = new RegistryInMemoryRedis();
  setRedisForTests(redis as any);
  process.env.PRESENCE_INSTANCE_ID = 'node-lease';

  const uid = 'creator-lease';
  await registerSocket(uid, 'sock-1', 'creator');

  assert.equal(await tryAcquireHeartbeatLease(uid), true);
  assert.equal(await isHeartbeatLeaseHolder(uid), true);
  assert.equal(await renewHeartbeatLease(uid), true);

  process.env.PRESENCE_INSTANCE_ID = 'node-other';
  assert.equal(await isHeartbeatLeaseHolder(uid), false);
  assert.equal(await renewHeartbeatLease(uid), false);

  process.env.PRESENCE_INSTANCE_ID = 'node-lease';
  await releaseHeartbeatLease(uid);
  assert.equal(await redis.get(presenceHbOwnerKey(uid)), null);
});

test('disconnect grace token match and cancel', async () => {
  const redis = new RegistryInMemoryRedis();
  setRedisForTests(redis as any);

  const uid = 'creator-grace';
  const { token } = await startDisconnectGrace(uid);
  assert.equal(await isDisconnectGraceActive(uid), true);

  assert.equal(await cancelDisconnectGrace(uid, randomUUID()), false);
  assert.equal(await isDisconnectGraceActive(uid), true);

  assert.equal(await cancelDisconnectGrace(uid, token), true);
  assert.equal(await isDisconnectGraceActive(uid), false);
});

test('lease renew refreshes registry hash ttl when sockets present', async () => {
  const redis = new RegistryInMemoryRedis();
  setRedisForTests(redis as any);
  process.env.PRESENCE_INSTANCE_ID = 'node-ttl';

  const uid = 'creator-ttl';
  await registerSocket(uid, 'sock-1', 'creator');
  await tryAcquireHeartbeatLease(uid);
  await renewHeartbeatLease(uid);

  const ttl = await redis.ttl(presenceSocketsKey(uid));
  assert.ok(ttl > 0);
});
