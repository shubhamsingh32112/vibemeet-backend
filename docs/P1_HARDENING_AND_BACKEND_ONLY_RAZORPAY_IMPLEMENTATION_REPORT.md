# P1 Hardening and Backend-Only Razorpay Implementation Report

## Scope Implemented

This implementation covers the P1 hardening wave items from `FULL_APP_AUDIT_AND_SCALE_READINESS.md` and adds strict backend-only Razorpay isolation so the Flutter app does not directly integrate with Razorpay.

Completed areas:

1. Payment boundary hardening (disable direct app Razorpay contract paths).
2. Referral attach mode correction for existing-user login.
3. Support daily cap race hardening with atomic guard logic.
4. Creator dashboard all-time summary optimization (DB pre-aggregation pattern).
5. Sensitive log masking/removal in key backend paths.
6. Permission prompt state made user-scoped in Flutter.
7. Flutter anti-coupling static guard against Razorpay SDK/identifier reintroduction.

---

## Architecture Outcome

### Before

- Flutter had no Razorpay SDK, but backend still exposed app-facing direct gateway endpoints (`/payment/create-order`, `/payment/verify`) and gateway-specific payload contracts.
- Existing transaction IDs and response fields included provider-specific naming.
- Some backend logs and webhook persistence retained high-detail sensitive/debug context.
- Support daily cap check used count-then-create pattern (race risk).
- Creator dashboard all-time summary used unbounded in-memory reduction of call history.
- Permission prompt display state was device-global (not user-scoped).

### After

- Mobile direct gateway endpoints are explicitly deprecated and blocked (`410`) to enforce web-checkout session flow only.
- App flow is backend session (`/payment/web/initiate`) -> browser checkout -> backend verify/webhook -> app deep link.
- Pending transaction resolution supports provider-neutral IDs (`pay_`) with compatibility for historical `razorpay_` rows.
- Existing-user login referral attachment now always uses `late_attach` constraints.
- Support ticket cap uses atomic document-based quota reservation.
- Creator all-time earnings summary is aggregation-first (no full history load).
- Sensitive request token and auth PII log fields were removed from key middleware/server paths.
- Permission prompt persistence is scoped by user identity.
- Static guard script now fails CI if Razorpay identifiers appear in Flutter runtime files.

---

## File-by-File Change Log

## Payment / Gateway Boundary

- `backend/src/modules/payment/payment.controller.ts`
  - Added provider-neutral helpers:
    - `buildPendingTransactionId(orderId) -> pay_<orderId>`
    - order transaction selector set including legacy `razorpay_` IDs.
  - `createOrder` now returns `410` with `PAYMENT_APP_DIRECT_FLOW_DISABLED`.
  - `verifyPayment` now returns `410` with `PAYMENT_APP_DIRECT_FLOW_DISABLED`.
  - `createPendingCoinTransaction` now writes `transactionId: pay_<orderId>`.
  - Web verify failure lookup updated to provider-neutral selector set.
  - App-facing success payload now returns `transactionRef` (Mongo `_id`) instead of provider-tied transaction ID field.
  - `RAZORPAY_KEY_ID is not configured` error sanitized to generic checkout-unavailable message.
  - Webhook event persistence changed to minimal audit payload via `buildWebhookAuditPayload` (no full raw payload document storage).
  - Multiple payment error logs now redact raw object dumps and emit sanitized message-only logs.

- `backend/src/modules/payment/payment-finalization.service.ts`
  - Finalization lookup changed from single `razorpay_<orderId>` to selector set:
    - `pay_<orderId>`
    - `razorpay_<orderId>` (backward compatibility)
    - `paymentGatewayOrderId`

- `backend/src/middlewares/webhook-signature.middleware.ts`
  - Razorpay webhook verification now requires `RAZORPAY_WEBHOOK_SECRET` only.
  - Removed fallback to `RAZORPAY_KEY_SECRET` to tighten key separation.

## Referral Mode Correction

- `backend/src/modules/auth/auth.controller.ts`
  - Existing-user login referral application now uses:
    - `applyReferralCode(..., { mode: 'late_attach' })`
  - This ensures existing-account attach obeys late-attach policy constraints already enforced in referral service.

## Support Daily Cap Atomicity

- `backend/src/modules/support/support-daily-counter.model.ts` (new)
  - Added `SupportDailyCounter` with unique index:
    - `{ userId, dayKey }`
  - Tracks per-user daily consumed ticket slots.

- `backend/src/modules/support/support.controller.ts`
  - Added `MAX_DAILY_TICKETS = 5`.
  - Added atomic reservation function:
    - `reserveDailySupportTicketSlot(userId)`
      - atomic increment if `count < max`
      - safe insert for first ticket
      - duplicate-key retry path for concurrent first writes
  - Added rollback helper:
    - `releaseDailySupportTicketSlot(userId)`
  - Replaced race-prone `countDocuments + create` with reservation flow.
  - On ticket-create failure, reserved slot is released.

## Creator Dashboard Pre-Aggregation

- `backend/src/modules/creator/creator.controller.ts`
  - `getCreatorEarnings`:
    - all-time summary now uses aggregation pipeline (`$match + $group`) for totals.
    - recent calls are fetched as bounded list (`limit(50)`).
  - `getCreatorDashboard`:
    - all-time earnings summary now uses aggregation pipeline.
    - recent calls remain bounded (`limit(20)`).
  - Removed unbounded all-time in-memory reduction of all call rows.

## Sensitive Log Hardening

- `backend/src/server.ts`
  - Request logging removed `authHeaderPrefix`.
  - Keeps only `hasAuth` boolean.

- `backend/src/middlewares/auth.middleware.ts`
  - Removed token-length logging.
  - Removed email/phone logging from token verification success logs.
  - Keeps safe auth success context (UID + path only).

- `backend/src/modules/payment/payment.controller.ts`
  - Sanitized several error logs from raw object dumps to message-only logging.
  - Reduced webhook payload persistence footprint.

## Permission Prompt User-Scoped State

- `frontend/lib/core/services/permission_prompt_service.dart`
  - Replaced global key with user-scoped key pattern:
    - `has_shown_permission_prompt:<uid>`
  - API updated to require user id:
    - `hasShownPermissionPrompt(String userId)`
    - `markPermissionPromptAsShown(String userId)`
  - reset helper supports optional user ID for targeted cleanup.

- `frontend/lib/features/home/screens/home_screen.dart`
  - Permission prompt flag checks now use authenticated `firebaseUid`.
  - Removed pre-show mark-as-shown behavior.
  - Mark-as-shown now occurs after successful permission grant only.

## Flutter Anti-Coupling Guard

- `backend/scripts/check-flutter-payment-boundary.cjs` (new)
  - Scans Flutter runtime/config files for blocked patterns:
    - `razorpay`, `rzp_`, `razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature`
  - Exits non-zero on violations.

- `backend/package.json`
  - Added script:
    - `guard:flutter-payment-boundary`

---

## Verification Runbook and Results

Executed checks:

1. `npm run guard:flutter-payment-boundary` (backend)
   - Result: **passed**
2. `npm run type-check` (backend)
   - Result: **passed**

No linter errors were reported in modified files via workspace lint diagnostics.

---

## Security and Compliance Notes

- Flutter app runtime remains free of direct Razorpay SDK/API references.
- Mobile app is forced away from direct gateway endpoints by explicit backend deprecation responses.
- Webhook secret handling tightened to dedicated secret only.
- Sensitive auth header prefix logging removed from request logs.
- Payment webhook storage reduced to minimal audit metadata.

---

## Backward Compatibility and Migration Notes

- Historical `CoinTransaction.transactionId = razorpay_<orderId>` rows remain supported in finalization and verify lookups.
- New pending rows use `pay_<orderId>` provider-neutral format.
- Deprecated endpoint responses are explicit and include machine-readable error code:
  - `PAYMENT_APP_DIRECT_FLOW_DISABLED`

---

## Residual Risks and Follow-Ups

1. Some legacy debug logging still exists in other modules outside this P1 pass and should be systematically normalized into shared logger patterns.
2. Legacy payment route handlers remain mounted (now hard-deprecated) for compatibility; removal can be a future cleanup step after client deprecation window.
3. Web checkout internal contracts still involve gateway identifiers server-side by design; this remains acceptable under backend-only gateway policy.

---

## Final Status

P1 hardening tasks and backend-only Razorpay boundary enforcement have been implemented, verified, and documented in this report.
