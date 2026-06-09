/** Telemetry-only shadow compare; does not change authoritative path unless registry flag is off. */
export function isPresenceRegistryShadow(): boolean {
  return process.env.PRESENCE_REGISTRY_SHADOW === 'true';
}

export function isPresenceRegistryEnabled(): boolean {
  return process.env.PRESENCE_REDIS_SOCKET_REGISTRY_ENABLED === 'true';
}

export function useRegistryAsAuthoritative(): boolean {
  return isPresenceRegistryEnabled();
}

/** Dual-write registry when shadow telemetry or full registry mode is active. */
export function shouldDualWriteRegistry(): boolean {
  return isPresenceRegistryShadow() || isPresenceRegistryEnabled();
}
