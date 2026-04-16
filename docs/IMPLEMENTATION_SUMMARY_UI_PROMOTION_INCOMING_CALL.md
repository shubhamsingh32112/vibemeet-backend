# Implementation Summary: UI + Promotion Ledger + Incoming Call Top Sheet

## Scope completed
- Task 1: Account Settings + Help & Support bottom-sheet top padding fixed.
- Task 2: Creator promotion now writes a visible fixed `-30` transaction entry.
- Task 3: Creator incoming call UI redesigned to adaptive top sheet (`30-40%`) with subtle scrim.
- Production readiness artifacts and validation checks added.

## Batch-by-batch completion

## Batch 0
- Baseline and guardrails documented.
- File:
  - `backend/docs/CHANGELOG_BATCH_0_BASELINE.md`

## Batch 1
- Added shared sheet body top spacing token and applied it to both affected sheets.
- Files:
  - `frontend/lib/shared/widgets/brand_app_chrome.dart`
  - `frontend/lib/features/account/screens/account_settings_screen.dart`
  - `frontend/lib/features/account/screens/help_support_screen.dart`
  - `backend/docs/CHANGELOG_BATCH_1_SHEET_PADDING.md`

## Batch 2
- Implemented idempotent promotion bonus reversal ledger write (`-30`) and wired it in all active promotion flows.
- Files:
  - `backend/src/modules/creator/creator-starter.service.ts`
  - `backend/src/modules/user/user.controller.ts`
  - `backend/src/modules/agent/agent.controller.ts`
  - `backend/src/modules/creator/creator.controller.ts`
  - `backend/docs/CHANGELOG_BATCH_2_PROMOTION_LEDGER.md`

## Batch 3
- Refactored incoming call overlay from centered/full-screen style to adaptive top sheet.
- Files:
  - `frontend/lib/features/video/widgets/incoming_call_listener.dart`
  - `frontend/lib/features/video/widgets/incoming_call_widget.dart`
  - `backend/docs/CHANGELOG_BATCH_3_INCOMING_TOPSHEET.md`

## Batch 4
- Added targeted backend/Flutter contract tests and recorded verification results and rollout gates.
- Files:
  - `backend/src/modules/creator/creator-promotion-ledger.contract.test.ts`
  - `backend/package.json`
  - `frontend/test/widget_test.dart`
  - `backend/docs/CHANGELOG_BATCH_4_PRODUCTION_READINESS.md`

## Why each change was made
- Bottom-sheet spacing: improve visual hierarchy and remove cramped header-to-content layout.
- Promotion ledger: ensure financial/user-visible audit trail is consistent with promotion-side coin removal.
- Incoming top-sheet: align creator incoming call UX to requested top-drawer interaction pattern while preserving existing call lifecycle behavior.
- Tests/docs: enforce regression checks and provide rollout/rollback operations clarity.

## Behavior changes (before -> after)
- Account/Help sheets:
  - Before: first content looked stuck to top/header.
  - After: consistent top breathing room using shared spacing token.
- Promotion transaction feed:
  - Before: coin reset happened with no visible transaction row.
  - After: fixed `-30` debit entry exists via idempotent transaction upsert across admin promote, admin create-creator, and agent create-creator flows.
- Incoming call UI:
  - Before: centered/full-screen call card style.
  - After: top-anchored adaptive sheet (`30-40%`), subtle scrim, preserved accept/reject behavior.

## Test evidence
- Frontend analyze pass on all touched files.
- Frontend test pass for updated contract tests (`2/2`).
- Backend targeted promotion-ledger tests pass (`4/4`).
- Full backend `npm test` still has an existing unrelated billing contract failure in `billing.flush.contract.test.ts`.

## Production rollout instructions
1. Deploy backend changes first (promotion ledger writer + tests).
2. Deploy frontend changes (sheet spacing + incoming top sheet).
3. Run smoke checks:
   - open Account Settings and Help & Support sheets,
   - promote user to creator and verify `-30` appears in creator transactions,
   - create creator via `POST /creator` path and verify the same `-30` entry appears,
   - trigger incoming call for creator and verify top-sheet placement/controls.
4. Monitor logs for promotion transaction upsert anomalies and incoming call UI errors.

## Rollback instructions
- If backend issue:
  - revert promotion helper wiring in:
    - `user.controller.ts`
    - `agent.controller.ts`
    - `creator.controller.ts`
    - `creator-starter.service.ts`
- If frontend issue:
  - revert UI-only files:
    - account/help screens
    - incoming listener/widget
    - shared spacing token
- Re-run targeted verify commands from `CHANGELOG_BATCH_4_PRODUCTION_READINESS.md`.

