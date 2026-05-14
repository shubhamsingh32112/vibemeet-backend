/**
 * Dashboard presence counts — Redis SETs + pipelined SCARD (no SCAN in hot paths).
 */
import { getRedis } from '../../config/redis';

export const PRESENCE_ONLINE_CREATORS_SET = 'presence:online_creators';

export function presenceOnlineByBdKey(bdId: string): string {
  return `presence:online_by_bd:${bdId}`;
}

export function presenceOnlineByAgencyKey(bdId: string): string {
  return `presence:online_by_agency:${bdId}`;
}

/** Pipelined SCARD — mandatory for batch reads (single RTT). */
export async function pipelineScard(keys: string[]): Promise<number[]> {
  if (keys.length === 0) return [];
  const redis = getRedis();
  const pipeline = redis.pipeline();
  for (const key of keys) {
    pipeline.scard(key);
  }
  const results = await pipeline.exec();
  if (!results) return keys.map(() => 0);
  return results.map((row) => {
    const val = row?.[1];
    return typeof val === 'number' ? val : 0;
  });
}

export async function updateOnlinePresenceSets(
  firebaseUid: string,
  transition: 'online' | 'offline',
  scope: { bdId?: string; agencyId?: string }
): Promise<void> {
  const redis = getRedis();
  const pipeline = redis.pipeline();
  const sets = [PRESENCE_ONLINE_CREATORS_SET];
  if (scope.bdId) sets.push(presenceOnlineByBdKey(scope.bdId));
  if (scope.agencyId) sets.push(presenceOnlineByAgencyKey(scope.agencyId));

  for (const key of sets) {
    if (transition === 'online') {
      pipeline.sadd(key, firebaseUid);
    } else {
      pipeline.srem(key, firebaseUid);
    }
  }
  await pipeline.exec();
}

export async function countOnlineCreatorsPlatform(): Promise<number> {
  const redis = getRedis();
  return redis.scard(PRESENCE_ONLINE_CREATORS_SET);
}

export async function countOnlineCreatorsForAgency(bdId: string): Promise<number> {
  const redis = getRedis();
  return redis.scard(presenceOnlineByAgencyKey(bdId));
}

export async function countOnlineCreatorsForBd(bdId: string): Promise<number> {
  const redis = getRedis();
  return redis.scard(presenceOnlineByBdKey(bdId));
}

export async function countOnlineByAgencyIds(agencyIds: string[]): Promise<Map<string, number>> {
  const keys = agencyIds.map(presenceOnlineByAgencyKey);
  const counts = await pipelineScard(keys);
  const map = new Map<string, number>();
  agencyIds.forEach((id, i) => map.set(id, counts[i] ?? 0));
  return map;
}

export async function countOnlineByBdIds(bdIds: string[]): Promise<Map<string, number>> {
  const keys = bdIds.map(presenceOnlineByBdKey);
  const counts = await pipelineScard(keys);
  const map = new Map<string, number>();
  bdIds.forEach((id, i) => map.set(id, counts[i] ?? 0));
  return map;
}
