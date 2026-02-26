# Phase 5 Controller Decomposition (Strangler)

## What changed

- Added legacy snapshots:
  - `src/modules/admin/admin.legacy.controller.ts`
  - `src/modules/creator/creator.legacy.controller.ts`
  - `src/modules/video/video.legacy.webhook.ts`
  - `src/modules/payment/payment.legacy.controller.ts`
- Added thin adapters (same route signatures and response contracts):
  - `src/modules/admin/admin.controller.ts`
  - `src/modules/creator/creator.controller.ts`
  - `src/modules/video/video.webhook.ts`
  - `src/modules/payment/payment.controller.ts`
- Added application services:
  - `src/modules/admin/admin.application.service.ts`
  - `src/modules/creator/creator.application.service.ts`
  - `src/modules/video/video-webhook.application.service.ts`
  - `src/modules/payment/payment.application.service.ts`
- Added repositories:
  - `src/modules/admin/admin.repository.ts`
  - `src/modules/creator/creator.repository.ts`
  - `src/modules/video/video.repository.ts`
  - `src/modules/payment/payment.repository.ts`

## Feature flags (default false)

- `FF_ADMIN_CONTROLLER_SERVICE_CUTOVER`
- `FF_CREATOR_CONTROLLER_SERVICE_CUTOVER`
- `FF_VIDEO_WEBHOOK_SERVICE_CUTOVER`
- `FF_PAYMENT_CONTROLLER_SERVICE_CUTOVER`

## Old -> New responsibility map

- **Route adapters** now only forward `req/res` to module application services.
- **Application services** own orchestration and cutover decision (legacy path vs new path).
- **Repositories** are module data-access entry points for the extracted paths.
- **Legacy controllers/webhook** remain the source of truth while flags are off.

## Verification-first artifacts

- Added unit tests for extracted service rules:
  - `src/tests/controller-decomposition-services.test.ts`

## Rollback

- Keep all new cutover flags at `false` (default) to run fully on legacy code.
- If any module is turned on and regresses, set that module flag back to `false` and redeploy.
- No route, payload, or contract rollback is required because adapters are signature-compatible.

