import { logInfo, logWarning } from '../utils/logger';

export type EcsServiceRole =
  | 'monolith'
  | 'api-ws'
  | 'billing-worker'
  | 'moments-worker'
  | 'image-worker';

const VALID_ROLES: ReadonlySet<EcsServiceRole> = new Set([
  'monolith',
  'api-ws',
  'billing-worker',
  'moments-worker',
  'image-worker',
]);

const LEGACY_RUN_BACKGROUND_WORKERS = 'RUN_BACKGROUND_WORKERS';

function parseRole(raw: string | undefined): EcsServiceRole {
  const trimmed = (raw || '').trim().toLowerCase();
  if (!trimmed) {
    return 'monolith';
  }
  if (VALID_ROLES.has(trimmed as EcsServiceRole)) {
    return trimmed as EcsServiceRole;
  }
  throw new Error(
    `Invalid ECS_SERVICE_ROLE="${raw}". Expected one of: ${[...VALID_ROLES].join(', ')}`,
  );
}

function assertEcsRoleWhenOnEcs(role: EcsServiceRole): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (role !== 'monolith') return;
  if (!process.env.ECS_CONTAINER_METADATA_URI_V4 && !process.env.ECS_CONTAINER_METADATA_URI) {
    return;
  }
  throw new Error(
    'ECS task detected but ECS_SERVICE_ROLE is unset. Set api-ws, billing-worker, moments-worker, or image-worker.',
  );
}

function assertNoConflictingLegacyFlags(role: EcsServiceRole): void {
  const legacy = process.env[LEGACY_RUN_BACKGROUND_WORKERS];
  if (legacy == null || legacy === '') return;

  const legacyFalse = legacy === 'false' || legacy === '0';
  const legacyTrue = legacy === 'true' || legacy === '1';

  if (legacyFalse && role !== 'api-ws' && role !== 'monolith') {
    logWarning(`${LEGACY_RUN_BACKGROUND_WORKERS}=false ignored; ECS_SERVICE_ROLE=${role} controls workers`, {});
  }
  if (legacyTrue && role === 'api-ws') {
    throw new Error(
      `Conflicting config: ECS_SERVICE_ROLE=api-ws with ${LEGACY_RUN_BACKGROUND_WORKERS}=true`,
    );
  }
}

let cachedRole: EcsServiceRole | null = null;

export function getServiceRole(): EcsServiceRole {
  if (cachedRole) return cachedRole;
  const role = parseRole(process.env.ECS_SERVICE_ROLE);
  assertEcsRoleWhenOnEcs(role);
  assertNoConflictingLegacyFlags(role);
  cachedRole = role;
  logInfo('Service role resolved', {
    serviceRole: role,
    ecsTask: !!(process.env.ECS_CONTAINER_METADATA_URI_V4 || process.env.ECS_CONTAINER_METADATA_URI),
  });
  return role;
}

export function isMonolithRole(): boolean {
  return getServiceRole() === 'monolith';
}

export function isApiWsRole(): boolean {
  const role = getServiceRole();
  return role === 'monolith' || role === 'api-ws';
}

export function isBillingWorkerRole(): boolean {
  const role = getServiceRole();
  return role === 'monolith' || role === 'billing-worker';
}

export function isMomentsWorkerRole(): boolean {
  const role = getServiceRole();
  return role === 'monolith' || role === 'moments-worker';
}

export function isImageWorkerRole(): boolean {
  const role = getServiceRole();
  return role === 'monolith' || role === 'image-worker';
}

export function runsHttpApi(): boolean {
  return isApiWsRole();
}

export function runsBillingWorkers(): boolean {
  return isBillingWorkerRole();
}

export function runsMomentsWorkers(): boolean {
  return isMomentsWorkerRole();
}

export function runsImageWorkers(): boolean {
  return isImageWorkerRole();
}

export function runsApiHygieneIntervals(): boolean {
  return isApiWsRole();
}

/** Reset cached role (tests only). */
export function resetServiceRoleCacheForTests(): void {
  cachedRole = null;
}
