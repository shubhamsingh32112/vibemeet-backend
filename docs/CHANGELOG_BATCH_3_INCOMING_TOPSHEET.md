# Batch 3: Creator Incoming Call UI to Adaptive Top Sheet

## What changed

### Overlay container behavior
- Updated `frontend/lib/features/video/widgets/incoming_call_listener.dart`:
  - Replaced full opaque overlay wrapper with a subtle scrim:
    - `Colors.black.withValues(alpha: 0.26)`
  - Kept existing listener, dismissal, and handled-call flow unchanged.

### Incoming call layout behavior
- Updated `frontend/lib/features/video/widgets/incoming_call_widget.dart`:
  - Added adaptive height helper:
    - `<700px`: `40%`
    - `<900px`: `35%`
    - `>=900px`: `30%`
  - Reworked layout from full-screen centered body to top-anchored sheet:
    - `SafeArea(bottom: false)` + `Align(alignment: Alignment.topCenter)`
    - constrained max width for larger displays
    - compact top spacing and top-header + body structure
  - Kept accept/reject button behavior and call processing state logic intact.

## Why
- Previous incoming call UI was centered and looked like a full-screen modal, which did not match the requested creator UX.
- New layout behaves as a top sheet drawer and preserves the same call-control behavior.

## UX result
- Incoming call prompt appears below top safe area as a top sheet.
- Height adapts in the requested `30-40%` range by screen size.
- Background stays visible with a subtle scrim, improving context continuity.

## Validation checklist
- [ ] Creator incoming call appears anchored at top (not center).
- [ ] Top sheet occupies ~30-40% based on screen height.
- [ ] Accept/reject still works and transitions correctly.
- [ ] Dismiss path and timeout path still clear overlay reliably.
- [ ] No overlap into unsafe status-bar/notch region.

## Risk and rollback
- Risk is medium-low and UI-localized (presentation refactor only).
- Rollback path: revert incoming widget/listener files to previous full-screen overlay layout.

