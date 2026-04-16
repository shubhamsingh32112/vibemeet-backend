# Batch 1: Account/Help Bottom Sheet Padding Fix

## What changed
- Added a shared sheet body top spacing constant:
  - `frontend/lib/shared/widgets/brand_app_chrome.dart`
  - `brandSheetBodyTopSpacing = 12`
- Updated Account Settings bottom sheet content padding:
  - `frontend/lib/features/account/screens/account_settings_screen.dart`
  - from horizontal-only padding to `EdgeInsets.fromLTRB(20, brandSheetBodyTopSpacing, 20, 20)`
- Updated Help & Support bottom sheet content padding:
  - `frontend/lib/features/account/screens/help_support_screen.dart`
  - from top `0` to `brandSheetBodyTopSpacing` with consistent body spacing.

## Why
- The first content block was rendering too close to the sheet header, making text appear stuck to the top.
- Shared spacing token keeps both sheets visually consistent and easier to maintain.

## UX result
- Cleaner visual separation between gradient header and first content block.
- More professional spacing rhythm across account-related bottom sheets.

## Validation checklist
- [ ] Account Settings bottom sheet: first card no longer cramped under header.
- [ ] Help & Support bottom sheet: heading and cards have visible breathing space.
- [ ] No clipping at `DraggableScrollableSheet` min/initial/max sizes.
- [ ] No regressions in sheet opening/closing and navigation to nested sheets.

## Risk and rollback
- Risk is low and UI-only (padding changes).
- Rollback is straightforward by reverting the two screen padding blocks and shared spacing constant.

