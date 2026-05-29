# Creator Presence Rollout Checklist

## Feature Flags

- `CREATOR_PRESENCE_USER_MODEL_ENABLED` (default `false`): migrate creator lifecycle to user-like base presence.
- `CREATOR_PRESENCE_USER_MODEL_SHADOW_COMPARE_ENABLED` (default `true`): emit parity diagnostics between legacy target state and user-model derived state.

## Rollout Phases

1. **Shadow Compare**
   - Keep `CREATOR_PRESENCE_USER_MODEL_ENABLED=false`.
   - Keep `CREATOR_PRESENCE_USER_MODEL_SHADOW_COMPARE_ENABLED=true`.
   - Track:
     - `presence.user_model_shadow_mismatch`
     - `creator_presence_user_model_shadow_mismatch`
2. **Canary Enablement**
   - Enable `CREATOR_PRESENCE_USER_MODEL_ENABLED=true` for 5% traffic.
   - Confirm sampled `creator.feed.presence_diagnostics` has stable `presenceAgeMs` and expected `presenceSource` values.
3. **Client Convergence Validation**
   - Validate reconnect behavior:
     - socket rehydrates all tracked creator IDs
     - creator status converges after resume/network bounce
4. **Ramp**
   - Expand from 5% -> 25% -> 50% -> 100%.
5. **Parity**
   - Compare creator self status vs user homepage badge for synthetic accounts every 5 minutes.
   - Alert if mismatch > 1% for 15 minutes.
6. **Rollback**
   - Disable `CREATOR_PRESENCE_USER_MODEL_ENABLED`.
   - Keep shadow compare on until mismatch root cause is fixed.

## Verification Commands

- Backend type-check: `npm run type-check`
- Focused presence tests:
  - `npx tsx --test src/modules/availability/presence-disconnect.contract.test.ts src/modules/availability/presence-single-writer.contract.test.ts src/modules/availability/creator-daily-online.service.test.ts`
- Frontend targeted analyzer:
  - `dart analyze lib/core/services/socket_service.dart lib/features/home/providers/availability_provider.dart lib/app/widgets/stream_chat_wrapper.dart`
