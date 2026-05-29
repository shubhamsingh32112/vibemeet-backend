# Creator Presence Rollout Checklist

## Feature Flags

- `CREATOR_PRESENCE_LEGACY_FALLBACK_READ_ENABLED` (default `false`): emergency read fallback to legacy `creator:availability:*`.
- `CREATOR_PRESENCE_LEGACY_DUAL_WRITE_ENABLED` (default `false`): migration-only dual write to legacy key.
- `CREATOR_PRESENCE_MISSING_WARN_RATE` (default `0.05`): warn threshold for canonical-missing batch rate.

## Rollout Phases

1. **Instrumentation + Backfill**
   - Run `npx tsx scripts/backfill-creator-presence-v2.ts`.
   - Track:
     - `creator_presence_batch_canonical_missing`
     - `creator_availability_batch_canonical_missing`
     - `presence.creator_presence_missing_canonical`
2. **Canonical Enforcement (Current Default)**
   - Keep fallback flags off.
   - Confirm sampled `creator.feed.presence_diagnostics` has mostly `presenceSource != missing_canonical`.
3. **Client Convergence Validation**
   - Validate reconnect behavior:
     - socket rehydrates all tracked creator IDs
     - creator status converges after resume/network bounce
4. **Canary + Parity**
   - Compare creator self status vs user homepage badge for synthetic accounts every 5 minutes.
   - Alert if mismatch > 1% for 15 minutes.
5. **Emergency Rollback**
   - If canonical keys are unexpectedly sparse, temporarily enable:
     - `CREATOR_PRESENCE_LEGACY_FALLBACK_READ_ENABLED=true`
   - Keep dual-write off unless migration requires back-compat writers.

## Verification Commands

- Backend type-check: `npm run type-check`
- Focused presence tests:
  - `npx tsx --test src/modules/availability/presence-disconnect.contract.test.ts src/modules/availability/presence-single-writer.contract.test.ts src/modules/availability/creator-daily-online.service.test.ts`
- Frontend targeted analyzer:
  - `dart analyze lib/core/services/socket_service.dart lib/features/home/providers/availability_provider.dart lib/app/widgets/stream_chat_wrapper.dart`
