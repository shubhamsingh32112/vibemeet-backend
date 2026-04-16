# Batch 4: Production Readiness, Validation, and Rollout Gates

## Validation commands run

### Frontend
- `flutter analyze lib/features/account/screens/account_settings_screen.dart lib/features/account/screens/help_support_screen.dart lib/shared/widgets/brand_app_chrome.dart lib/features/video/widgets/incoming_call_listener.dart lib/features/video/widgets/incoming_call_widget.dart test/widget_test.dart`
  - Result: pass (no issues).
- `flutter test test/widget_test.dart`
  - Result: pass (`2/2` tests).

### Backend
- `npx eslint src/modules/user/user.controller.ts src/modules/agent/agent.controller.ts src/modules/creator/creator-starter.service.ts src/modules/creator/creator-promotion-ledger.contract.test.ts`
  - Result: pass with one pre-existing warning in `user.controller.ts` (`no-explicit-any`, unrelated to this batch).
- `npx tsx --test src/modules/creator/creator-promotion-ledger.contract.test.ts`
  - Result: pass (`4/4` tests).
- `npm test`
  - Result: partial failure due an existing billing contract assertion in `billing.flush.contract.test.ts` (`expected refreshActiveCallSlotsTtl when sliding session TTL`), unrelated to this implementation.

## New tests added
- Backend:
  - `backend/src/modules/creator/creator-promotion-ledger.contract.test.ts`
  - Coverage:
    - fixed amount (`30`) contract,
    - deterministic transaction id contract,
    - admin and agent promotion path wiring contracts.
- Frontend:
  - `frontend/test/widget_test.dart` replaced with lightweight contract tests for:
    - shared bottom-sheet top spacing token usage,
    - incoming call top-sheet adaptive layout contract.

## Scale-oriented checks for target load
- No new polling loops or recurring background tasks added.
- Promotion ledger change adds one idempotent transaction upsert per promotion event only.
- Incoming call redesign is presentation-only and does not alter backend call frequency.
- Bottom sheet spacing changes are pure UI padding updates.

## Rollout gates (go/no-go)
- Go only if:
  - frontend analyze + tests remain green,
  - backend targeted promotion-ledger tests remain green,
  - manual sanity checks pass for all three user-facing tasks.
- Hold/No-go if:
  - promotion endpoint returns transaction conflicts unexpectedly,
  - incoming call overlay blocks accept/reject actions on real devices,
  - transaction feed does not show the promotion reversal row.

## Rollback triggers and action
- Trigger rollback if:
  - promotion operations fail inside transaction session,
  - incoming call UI regresses or becomes non-actionable,
  - account/help bottom sheets clip content.
- Rollback action:
  - Revert batch-specific files:
    - promotion helper wiring in backend controllers/service,
    - incoming call overlay layout files,
    - bottom-sheet spacing updates.

