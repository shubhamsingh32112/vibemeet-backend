# Presence Socket Registry Migration (Milestone B)

Cross-node socket coordination via Redis registry in `presence-socket-registry.service.ts`.

## Feature flags

| Env | Default | Behavior |
|-----|---------|----------|
| `PRESENCE_REDIS_SOCKET_REGISTRY_ENABLED` | `false` | Registry authoritative for connect/disconnect/grace/heartbeat |
| `PRESENCE_REGISTRY_SHADOW` | `false` | **Telemetry only** — dual-write + `shadow_mismatch` metrics; local tracker stays authoritative |

**Rollback:** `PRESENCE_REDIS_SOCKET_REGISTRY_ENABLED=false` on all `api-ws` tasks.

**Post-cutover safety net:** Enable `PRESENCE_REGISTRY_SHADOW=true` for one release (with or after full registry cutover) to compare local vs Redis counts under real mobile/ALB/deploy load. Shadow does not change authoritative path when registry flag is on.

## Rollout stages

1. Deploy with both flags off (Milestone A behavior)
2. Optional: `PRESENCE_REGISTRY_SHADOW=true` on all tasks — monitor mismatches 24h
3. Canary: `PRESENCE_REDIS_SOCKET_REGISTRY_ENABLED=true` on 1 `api-ws` task
4. Full cutover all tasks
5. Recommended: keep shadow telemetry available (`PRESENCE_REGISTRY_SHADOW`) for one production release after cutover

## Operational semantics

### Lease renew failure

| Event | Action |
|-------|--------|
| `renewHeartbeatLease` returns false | Stop heartbeat interval immediately |
| `renewHeartbeatLease` throws (timeout/partition) | Stop interval immediately; metric `presence.heartbeat_lease_renew_failed` |
| Never | Retry lease renew on next tick (risk: double writers) |

Other errors during `transitionCreatorPresence` / `refreshUserAvailability`: log and retry next tick (lease not assumed lost).

### Registry TTL vs presence TTL

Default: `PRESENCE_SOCKET_REGISTRY_TTL_SECONDS = CREATOR_PRESENCE_TTL + 30`.

Registry hash **must outlive** presence-state keys to avoid orphaning socket records during heartbeat gaps. Do not equalize TTLs without full chaos re-validation.

### Grace token hierarchy

1. **`hasAnySocket(uid)`** — authoritative before `DISCONNECTED`
2. **Grace token** — best-effort secondary aid; safe if Redis SET fails (local timer still runs)
3. **Local timer** — scheduling only; guarded by #1

## Acceptable chaos outcomes

| Outcome | Pass? |
|---------|-------|
| Transient count skew (±1, &lt;1s) | Allow |
| Duplicate online emits | Allow |
| Negative registry count | **Fail** |
| False offline &gt; grace while connected | **Fail** |
| Stuck online &gt; TTL + grace + 5s | **Fail** |

Run: `npm run chaos:presence`

## TTL authority

Registry hash `EXPIRE` only in: `registerSocket`, `renewHeartbeatLease` (lease holder), partial `unregisterSocket`. Never from sweeps.

## Sign-off checklist

- [ ] All `api-ws` tasks: `PRESENCE_REDIS_SOCKET_REGISTRY_ENABLED=true`
- [ ] Chaos harness green (8 scenarios on staging, ≥2 tasks)
- [ ] Optional: shadow mismatches near zero for 24h with `PRESENCE_REGISTRY_SHADOW=true`
- [ ] Rolling deploy during live session — no false offline
- [ ] `DISTRIBUTED_JOB_SAFETY_MATRIX.md` updated
