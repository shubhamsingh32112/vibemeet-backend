# Source of Truth Consolidation (Phase 4)

## Objective
- Eliminate ambiguity between Mongo, Redis, Stream and socket-local state.
- Define one canonical authority per domain and treat all other stores as projections.
- Keep existing API contracts and UX stable during migration.

## Canonical Authorities

### Presence Domain
- **Authority:** Redis availability keys (`creator:availability:{firebaseUid}`)
- **Projection stores:** `Creator.isOnline` in Mongo, socket broadcasts (`creator:status`)
- **Rule:** Mongo `isOnline` is informational/legacy only and should be reconciled to Redis.

### Active Call State Domain
- **Authority:** Redis call session keys (`call:session:*`, `call:user_coins:*`, `call:creator_earnings:*`)
- **Projection stores:** socket events (`billing:update`, `billing:settled`), Stream chat call activity messages
- **Rule:** sockets and Stream are output projections, never decision authority.

### Coin/Billing Domain
- **Authority:** Coin transaction journal (`CoinTransaction`, immutable append-only ledger)
- **Projection stores:** `User.coins` (materialized balance), admin dashboards/caches
- **Rule:** `User.coins` is a projection from completed ledger entries and may be repaired by reconciliation.

## Reconciliation (Detect + Repair Drift)
- Implementation: `src/modules/system/source-of-truth.service.ts`
- Scheduled job (every 5 minutes) in `src/server.ts` when enabled.
- Drift checks:
  1. Presence drift: Redis availability vs Mongo `Creator.isOnline`
  2. Billing drift: `User.coins` vs ledger-derived balance from `CoinTransaction`
- Repair behavior:
  - Controlled by feature flag.
  - Presence: update Mongo `isOnline` to Redis-derived status.
  - Billing: update `User.coins` to expected ledger balance (safe-guard: skip users with zero completed ledger entries).

## Admin Diagnostics
- Endpoint: `GET /api/v1/admin/system/drift`
- Optional: `?runNow=true` to trigger reconciliation before reading report.
- Returns latest reconciliation report including:
  - authority definitions
  - drift counts
  - sample drift records
  - whether repair mode was enabled

## Feature Flags
- `FF_SOT_RECONCILIATION_ENABLED` (default `false`)
  - Enables scheduled/manual reconciliation execution.
- `FF_SOT_RECONCILIATION_REPAIR` (default `false`)
  - Enables repair actions (otherwise detect-only mode).

## Rollout Plan (Strangler)
1. Enable detect-only mode in staging:
   - `FF_SOT_RECONCILIATION_ENABLED=true`
   - `FF_SOT_RECONCILIATION_REPAIR=false`
2. Validate drift reports over multiple days.
3. Enable repair in controlled environments:
   - `FF_SOT_RECONCILIATION_REPAIR=true`
4. Observe admin drift diagnostics and reconciliation logs.
5. Keep projections backward compatible until all consumers rely on canonical authorities.

## Rollback
1. Set `FF_SOT_RECONCILIATION_ENABLED=false` to stop reconciliation immediately.
2. If needed, set `FF_SOT_RECONCILIATION_REPAIR=false` while keeping detect mode on.
3. Revert Phase 4 files (`source-of-truth.service.ts`, route/controller additions) if full rollback is required.
