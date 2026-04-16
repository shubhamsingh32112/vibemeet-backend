# Batch 0 Baseline, Acceptance Criteria, and Guardrails

## Scope
- Establish the implementation baseline for:
  - Account/Help bottom sheet top padding cleanup.
  - Creator promotion bonus-reversal transaction visibility.
  - Creator incoming call overlay redesign to an adaptive top sheet.
- Define acceptance checks and rollback triggers before code changes.

## Baseline Findings (Code Evidence)

### 1) Bottom sheet content appears too close to top
- `AccountSettingsScreen` places content directly after `BrandSheetHeader` with no explicit top content gap.
- `HelpSupportScreen` uses top content padding `0`, which can look cramped under the sheet header.
- Files:
  - `frontend/lib/features/account/screens/account_settings_screen.dart`
  - `frontend/lib/features/account/screens/help_support_screen.dart`

### 2) Promotion removes coins but creates no ledger entry
- Promotion paths set user coins to `0` and mark `welcomeBonusClaimed`, but no `CoinTransaction` debit is inserted.
- Transaction screens read from `CoinTransaction`, so no row can appear for the deduction.
- Files:
  - `backend/src/modules/user/user.controller.ts`
  - `backend/src/modules/agent/agent.controller.ts`
  - `backend/src/modules/creator/creator-starter.service.ts`
  - `backend/src/modules/creator/creator.controller.ts`

### 3) Incoming creator-call UI is centered/full-screen style
- Incoming overlay is a full-screen `Material` with centered content (`Center` + `SingleChildScrollView`), not a top-anchored sheet.
- Header treatment and content anchoring do not match requested top-sheet behavior.
- Files:
  - `frontend/lib/features/video/widgets/incoming_call_listener.dart`
  - `frontend/lib/features/video/widgets/incoming_call_widget.dart`

## Confirmed Product Decisions
- Promotion ledger entry must be a fixed `-30` debit.
- Incoming creator-call UI should be an adaptive top sheet in the `30-40%` range with subtle scrim.

## Acceptance Criteria

### A) Bottom sheet spacing
- Account Settings and Help & Support bottom sheets have consistent top spacing under the gradient header.
- First text/content block is visually separated from header and no longer appears stuck.
- No clipping at min/initial/max draggable sizes.

### B) Promotion ledger entry
- On promotion, a fixed `-30` debit transaction is created in the same DB transaction/session.
- Entry is visible in creator transactions feed with clear description.
- Idempotent behavior: retries do not create duplicate debit records.

### C) Incoming call top sheet
- Incoming call UI renders as a top-anchored sheet below safe top area.
- Height adapts by screen size in the `30-40%` band.
- Accept/reject/dismiss behaviors remain unchanged and stable.

## No-Regression Checklist
- Existing call accept/reject/timeout logic remains functionally unchanged.
- Creator/user transaction endpoints preserve response shape expected by Flutter models.
- No added polling loops or heavy read amplification in hot paths.
- Existing auth, socket, and billing flows continue to compile and run.

## Risk Register
- **UI layout regression risk**: top sheet may overlap notches/status bars on edge devices.
  - Mitigation: enforce `SafeArea` and bounded adaptive height.
- **Ledger duplication risk**: promotion retry may double-insert debit.
  - Mitigation: deterministic `transactionId` and conflict-safe create path in same session.
- **Semantic confusion risk**: creator page labeling for debit entries may look odd if phrasing remains generic.
  - Mitigation: explicit transaction description and optional UI label mapping.

## Rollback Triggers
- Incoming call overlay blocks interaction or fails to dismiss correctly.
- Promotion endpoint fails transaction commit due to new ledger write path.
- Creator transactions endpoint returns inconsistent payload after change.
- Any newly introduced lint/type/test failures in touched files.

## Rollback Strategy
- Revert the batch that introduced the failing behavior.
- Keep previous stable behavior for unaffected batches.
- Re-run targeted checks before resuming forward rollout.

