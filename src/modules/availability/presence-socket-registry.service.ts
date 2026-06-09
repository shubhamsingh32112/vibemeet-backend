import { randomUUID } from 'crypto';
import {
  getRedis,
  presenceDisconnectGraceKey,
  presenceHbOwnerKey,
  presenceSocketsKey,
} from '../../config/redis';
import { getPresenceInstanceId } from './presence-instance-id';

export type PresenceSocketRole = 'creator' | 'user';

export interface PresenceSocketRecord {
  instanceId: string;
  version: number;
  connectedAt: number;
  role: PresenceSocketRole;
}

export interface RegisterSocketResult {
  count: number;
  version: number;
  isFirst: boolean;
}

export interface UnregisterSocketResult {
  count: number;
  removed: boolean;
}

const PRESENCE_TTL_SECONDS = Math.min(
  600,
  Math.max(90, parseInt(process.env.CREATOR_PRESENCE_TTL_SECONDS || '180', 10) || 180)
);

const REGISTRY_HASH_TTL_SECONDS = Math.min(
  630,
  Math.max(
    120,
    parseInt(
      process.env.PRESENCE_SOCKET_REGISTRY_TTL_SECONDS ||
        String(PRESENCE_TTL_SECONDS + 30),
      10
    ) || PRESENCE_TTL_SECONDS + 30
  )
);
// Intentionally PRESENCE_TTL + 30s: registry outlives presence-state keys so socket
// records are not orphaned during heartbeat gaps or HEARTBEAT TTL skip windows.
// Do not equalize with creator:availability TTL without a full regression review.

const HEARTBEAT_INTERVAL_MS = Math.min(
  Math.max(20_000, PRESENCE_TTL_SECONDS * 1000 - 15_000),
  Math.max(20_000, parseInt(process.env.CREATOR_HEARTBEAT_INTERVAL_MS || '45000', 10) || 45_000)
);

const HEARTBEAT_LEASE_TTL_MS = HEARTBEAT_INTERVAL_MS * 2;

const CREATOR_DISCONNECT_GRACE_MS = Math.min(
  30000,
  Math.max(0, parseInt(process.env.CREATOR_DISCONNECT_GRACE_MS || '3000', 10) || 3000)
);

const REGISTER_SOCKET_SCRIPT = `
local socketsKey = KEYS[1]
local socketId = ARGV[1]
local instanceId = ARGV[2]
local role = ARGV[3]
local connectedAt = ARGV[4]
local ttl = tonumber(ARGV[5])

local countBefore = redis.call('HLEN', socketsKey)
local existing = redis.call('HGET', socketsKey, socketId)
local version = 1
if existing then
  local ok, record = pcall(cjson.decode, existing)
  if ok and record and record.version then
    version = tonumber(record.version) + 1
  else
    version = 2
  end
end

local recordJson = cjson.encode({
  instanceId = instanceId,
  version = version,
  connectedAt = tonumber(connectedAt),
  role = role
})
redis.call('HSET', socketsKey, socketId, recordJson)
redis.call('EXPIRE', socketsKey, ttl)
local count = redis.call('HLEN', socketsKey)
local isFirst = countBefore == 0 and 1 or 0
return {count, version, isFirst}
`;

const UNREGISTER_SOCKET_SCRIPT = `
local socketsKey = KEYS[1]
local socketId = ARGV[1]
local version = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

local existing = redis.call('HGET', socketsKey, socketId)
if not existing then
  return {0, redis.call('HLEN', socketsKey)}
end

local ok, record = pcall(cjson.decode, existing)
if not ok or not record or tonumber(record.version) ~= version then
  return {0, redis.call('HLEN', socketsKey)}
end

redis.call('HDEL', socketsKey, socketId)
local count = redis.call('HLEN', socketsKey)
if count == 0 then
  redis.call('DEL', socketsKey)
else
  redis.call('EXPIRE', socketsKey, ttl)
end
return {1, count}
`;

const RENEW_HEARTBEAT_LEASE_SCRIPT = `
local hbKey = KEYS[1]
local socketsKey = KEYS[2]
local instanceId = ARGV[1]
local leaseTtlMs = tonumber(ARGV[2])
local registryTtl = tonumber(ARGV[3])

local current = redis.call('GET', hbKey)
if current ~= instanceId then
  return 0
end

redis.call('SET', hbKey, instanceId, 'PX', leaseTtlMs)
local count = redis.call('HLEN', socketsKey)
if count > 0 then
  redis.call('EXPIRE', socketsKey, registryTtl)
end
return 1
`;

const CANCEL_DISCONNECT_GRACE_SCRIPT = `
local graceKey = KEYS[1]
local token = ARGV[1]
local value = redis.call('GET', graceKey)
if value == token then
  redis.call('DEL', graceKey)
  return 1
end
return 0
`;

function registryUnavailable(): boolean {
  try {
    getRedis();
    return false;
  } catch {
    return true;
  }
}

export async function registerSocket(
  uid: string,
  socketId: string,
  role: PresenceSocketRole
): Promise<RegisterSocketResult> {
  if (registryUnavailable()) {
    return { count: 0, version: 0, isFirst: false };
  }
  const redis = getRedis();
  const instanceId = getPresenceInstanceId();
  const result = (await redis.eval(
    REGISTER_SOCKET_SCRIPT,
    1,
    presenceSocketsKey(uid),
    socketId,
    instanceId,
    role,
    String(Date.now()),
    String(REGISTRY_HASH_TTL_SECONDS)
  )) as [number, number, number];

  return {
    count: Number(result[0]),
    version: Number(result[1]),
    isFirst: Number(result[2]) === 1,
  };
}

export async function unregisterSocket(
  uid: string,
  socketId: string,
  version: number
): Promise<UnregisterSocketResult> {
  if (registryUnavailable()) {
    return { count: 0, removed: false };
  }
  const redis = getRedis();
  const result = (await redis.eval(
    UNREGISTER_SOCKET_SCRIPT,
    1,
    presenceSocketsKey(uid),
    socketId,
    String(version),
    String(REGISTRY_HASH_TTL_SECONDS)
  )) as [number, number];

  return {
    removed: Number(result[0]) === 1,
    count: Number(result[1]),
  };
}

export async function getSocketCount(uid: string): Promise<number> {
  if (registryUnavailable()) return 0;
  const redis = getRedis();
  return redis.hlen(presenceSocketsKey(uid));
}

export async function hasAnySocket(uid: string): Promise<boolean> {
  const count = await getSocketCount(uid);
  return count > 0;
}

/** DEBUG/TESTS ONLY — never use in gateway, sweeps, or reconciliation. */
export async function listSocketIds(uid: string): Promise<string[]> {
  if (registryUnavailable()) return [];
  if (process.env.PRESENCE_REGISTRY_DEBUG !== 'true' && process.env.NODE_ENV === 'production') {
    return [];
  }
  const redis = getRedis();
  return redis.hkeys(presenceSocketsKey(uid));
}

export async function tryAcquireHeartbeatLease(uid: string): Promise<boolean> {
  if (registryUnavailable()) return false;
  const redis = getRedis();
  const instanceId = getPresenceInstanceId();
  const result = await redis.set(
    presenceHbOwnerKey(uid),
    instanceId,
    'PX',
    HEARTBEAT_LEASE_TTL_MS,
    'NX'
  );
  return result === 'OK';
}

export async function renewHeartbeatLease(uid: string): Promise<boolean> {
  if (registryUnavailable()) return false;
  const redis = getRedis();
  const instanceId = getPresenceInstanceId();
  const result = (await redis.eval(
    RENEW_HEARTBEAT_LEASE_SCRIPT,
    2,
    presenceHbOwnerKey(uid),
    presenceSocketsKey(uid),
    instanceId,
    String(HEARTBEAT_LEASE_TTL_MS),
    String(REGISTRY_HASH_TTL_SECONDS)
  )) as number;
  return Number(result) === 1;
}

export async function releaseHeartbeatLease(uid: string): Promise<void> {
  if (registryUnavailable()) return;
  const redis = getRedis();
  const instanceId = getPresenceInstanceId();
  const current = await redis.get(presenceHbOwnerKey(uid));
  if (current === instanceId) {
    await redis.del(presenceHbOwnerKey(uid));
  }
}

export async function isHeartbeatLeaseHolder(uid: string): Promise<boolean> {
  if (registryUnavailable()) return false;
  const redis = getRedis();
  const current = await redis.get(presenceHbOwnerKey(uid));
  return current === getPresenceInstanceId();
}

export async function startDisconnectGrace(uid: string): Promise<{ token: string }> {
  const token = randomUUID();
  if (registryUnavailable()) {
    return { token };
  }
  const redis = getRedis();
  await redis.set(
    presenceDisconnectGraceKey(uid),
    token,
    'PX',
    CREATOR_DISCONNECT_GRACE_MS
  );
  return { token };
}

export async function cancelDisconnectGrace(uid: string, token: string): Promise<boolean> {
  if (registryUnavailable()) return false;
  const redis = getRedis();
  const result = (await redis.eval(
    CANCEL_DISCONNECT_GRACE_SCRIPT,
    1,
    presenceDisconnectGraceKey(uid),
    token
  )) as number;
  return Number(result) === 1;
}

export async function isDisconnectGraceActive(uid: string): Promise<boolean> {
  if (registryUnavailable()) return false;
  const redis = getRedis();
  const value = await redis.get(presenceDisconnectGraceKey(uid));
  return value != null && value.length > 0;
}
