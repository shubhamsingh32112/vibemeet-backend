# Full App Functional and Scale Readiness Audit

Date: 2026-04-17  
Scope: `backend` + `frontend` application layers  
Target profile: `1000 users/day`, `200 creators`, `50 concurrent 1:1 calls`

## Executive Summary

This audit reviewed the full requested app surface area: login, popups, permissions, bonus, UI lifecycle, video, chat, coin purchase, referral, help/support, and creator task progression. The codebase has strong modular structure and several good safeguards (rate limits, role checks, atomic chat pre-send billing, Stream video webhook signature verification, and startup production security checks).

Main readiness conclusion:
- The app is close to handling your target load, but there are **P0 correctness/security gaps** in payment and webhook handling that should be fixed before scaling aggressively.
- The most material scale pressure point is real-time billing/event throughput during `50 concurrent calls` with a `300ms` billing tick and batch cap of `50`.
- Several workflows are robust but rely on optimistic patterns that can produce race conditions under burst traffic.

## Method

- Cross-layer feature trace: endpoint -> service/controller -> model -> frontend screens/providers.
- Line-by-line review of critical and high-traffic paths for each requested domain.
- Security/idempotency review for auth, permissions, bonus, referral, and payment.
- Capacity modeling against your deployment stack:
  - Railway Pro backend
  - Railway Redis
  - MongoDB Atlas Flex
  - Stream Video and Stream Chat
  - Firebase Blaze
  - Razorpay

## Feature Coverage Matrix

| Domain | Backend Coverage | Frontend Coverage | Status |
|---|---|---|---|
| Login/Auth | `modules/auth`, `middlewares/auth.middleware.ts` | `features/auth/*`, `app/router/app_router.dart` | Partial risk |
| Popups/UI lifecycle | N/A (client-driven) | `app/widgets/app_lifecycle_wrapper.dart`, `home_screen.dart`, shared popups | Partial risk |
| Permissions | Token/role enforcement in middleware + routes | `permission_prompt_service.dart`, `permission_service.dart`, home flow | Partial risk |
| Bonus | `user.controller.ts` (`claimWelcomeBonus`) + identity ledger | Welcome bonus dialogs/flows | Partial risk |
| Video calling | `modules/video/*`, `modules/billing/*`, `modules/availability/*` | `features/video/*`, lifecycle + overlays | Partial risk |
| Chat | `modules/chat/*`, quota and coin deduction paths | `features/chat/*`, stream providers | Partial risk |
| Buying coins | `modules/payment/*`, coin transactions | `features/wallet/*`, deep-link return | High risk |
| Referral | `modules/referral/*`, `user/referral.service.ts` | `features/referral/*`, login integration | Partial risk |
| Help/Support | `modules/support/*` | `features/support/*`, account support screens | Partial risk |
| Creator task progression | `modules/creator/*`, `creator-task` + call history | `features/creator/*`, dashboard providers | Partial risk |

## Detailed Findings by Domain

### 1) Login and Auth

Strengths:
- Unified auth middleware supports Firebase tokens and admin/agent JWT flows.
- Production startup enforces non-default `JWT_SECRET` and configured admin credentials.
- Most sensitive modules apply `verifyFirebaseToken`.

Findings:
- **High**: default fallback secrets/credentials exist in runtime code paths (`auth.controller.ts`, `auth.middleware.ts`). Production guard exists, but non-production/staging misuse risk remains.
- **Medium**: router-level auth redirects are not centralized in Flutter router; auth navigation correctness depends on screen/provider behavior.

### 2) Popups and Permission Prompts

Strengths:
- Permission prompts are delayed until home UI stabilizes.
- Deep-link dedupe avoids repeated payment result popups.

Findings:
- **Medium**: permission prompt persistence key is global (`has_shown_permission_prompt`), not per-user; one account can suppress prompts for another on same device.
- **Medium**: prompt is marked shown *before* dialog completion; failed/aborted flows can suppress future prompts.
- **Low**: deep-link dedupe by `paymentStatus:orderId` can hide legitimate repeats for same order status.

### 3) Bonus Logic

Strengths:
- Welcome bonus claim uses identity-ledger first-claim semantics to reduce duplicate grants.
- Bonus emits real-time coin updates after success.

Findings:
- **Low/Medium**: welcome bonus transaction is recorded with `source: 'admin'` instead of a dedicated `welcome_bonus` source, reducing audit clarity.
- **Medium**: transaction save and user coin increment are sequential rather than explicit DB transaction boundary.

### 4) Buying Coins (Razorpay)

Strengths:
- Payment signature checks implemented in app and web verify paths.
- Web verify includes server-to-server payment capture/order validation.

Findings:
- **Critical**: `/payment/verify` (app path) does not do equivalent full S2S capture/order verification before crediting.
- **Critical**: coin credit and transaction completion are check-then-write operations, not atomic conditional update/transaction; duplicate credits are possible under race conditions.
- **High**: no Razorpay webhook reconciliation route for authoritative recovery when client/web callback fails.
- **Medium**: web payment endpoints are token-authenticated but not explicitly rate-limited.

### 5) Referral

Strengths:
- Referral edge uniqueness and atomic reward grant update patterns are present.
- Reward transaction IDs are deterministic/idempotent.

Findings:
- **High**: login-time referral for existing users uses `mode: 'signup'`, which may bypass intended late-attach restrictions (window/first-purchase checks).
- **Medium**: referral apply spans multiple writes with compensating rollback only on duplicate key branch; no full transaction envelope.

### 6) Chat

Strengths:
- `pre-send` flow uses Mongo transaction for quota + coin + ledger updates (good financial consistency).
- Idempotency lock/caching exists for concurrent pre-send taps.

Findings:
- **High**: `POST /chat/webhook` has no signature verification middleware.
- **Medium**: on channel-creator cache miss, `channel.watch()` is called in hot path, adding external dependency latency bursts.

### 7) Video Calling and Billing

Strengths:
- Video webhook applies signature verification and rate limiter.
- Billing includes lock/queue/backpressure instrumentation and recovery services.

Findings:
- **High (scale)**: billing batch cap is `50` and tick interval is `300ms`; with exactly 50 concurrent calls, there is minimal headroom for drift/retries.
- **Medium**: heavy per-tick Redis operations can become bottleneck at target concurrent calls if Redis latency spikes.
- **Medium**: in-memory request queue/backpressure is per-process, not globally coordinated across multiple replicas.

### 8) Help and Support

Strengths:
- Auth-protected support routes and basic input validation.
- Daily ticket limit implemented.

Findings:
- **Medium**: daily ticket cap uses read-then-create pattern; concurrent requests can exceed intended limit.

### 9) Creator Task Progression and Dashboard

Strengths:
- Task progression integrates with period-bounded aggregates and claim flow.
- Dashboard cache exists with Redis fallback.

Findings:
- **High (scale)**: creator dashboard fetches full call history and reduces in memory for all-time metrics; this can degrade for high-volume creators.
- **Medium**: dashboard endpoint does multiple aggregates and transforms in one request path; may need precomputed summaries for growth.

### 10) UI / Realtime Integration Risks

Findings:
- **Medium**: extensive debug logging in hot paths (sockets/API/chat/video) can increase CPU/I/O and leak sensitive data in debug environments.
- **Medium**: dual availability socket systems on client increase complexity and event duplication risk.
- **Low/Medium**: incoming call avatar fallback queries full creator list (`GET /creator`) for lookup, adding avoidable payload/latency.

## Security and Abuse-Resistance Findings

### P0/P1 Security Concerns

1. **P0** Missing chat webhook signature verification (`/chat/webhook`).
2. **P0** Payment app verify path can credit after signature check without full payment capture/order fetch parity.
3. **P0** Non-atomic payment credit path can race into double credit.
4. **P1** Existing-user referral application mode mismatch (`signup` vs expected `late_attach` policy).
5. **P1** Token/header/OTP debug logging can expose sensitive values during QA/log collection.

## Scale Readiness for Your Target Load

### Load decomposition

- `1000 users/day` average is modest at app level, but mobile/social usage is bursty.
- `50 concurrent 1:1 calls` is the dominant stressor due to billing ticks and socket/event fanout.
- With `BILLING_PROCESS_INTERVAL_MS = 300`, expected scheduler load is roughly:
  - ~3.33 billing cycles/second per call
  - ~166+ cycles/second across 50 active calls before retries/overhead

### Infrastructure fit (given stack)

- Railway Pro backend + Railway Redis can support this profile if:
  - billing driver and worker scaling are configured correctly,
  - Redis latency remains low under call spikes,
  - CPU/memory headroom is monitored for event-loop lag.
- MongoDB Atlas Flex can become a limiting factor on high-frequency dashboard/history reads and write spikes if indexes and query patterns are not optimized.
- Stream Video/Chat are suitable for this concurrency band; main risk is your server-side webhook and cache-miss handling.
- Razorpay flow is functionally integrated but not fully resilient without webhook reconciliation.

## Prioritized Remediation Roadmap

### P0 (Do before scaling)

1. Add authenticated verification for `chat` webhooks (signature + limiter).
2. Make payment crediting atomic:
   - use conditional update (`status != completed`) and transaction/session for transaction + user coin mutation.
3. Add Razorpay webhook reconciliation endpoint and replay-safe handler.
4. Align `/payment/verify` security with web verify (order/payment fetch and capture verification).

### P1 (Next hardening wave)

1. Correct referral mode for existing-user login attach (respect late-attach constraints).
2. Convert support daily ticket cap to atomic counter or transactional guard.
3. Move creator dashboard all-time summary to pre-aggregated/stat collection or bounded windows.
4. Remove or mask sensitive debug logs (headers, OTP, tokens).
5. Make permission prompt state user-scoped.

### P2 (Scale optimization)

1. Unify client socket availability pathways to one source of truth.
2. Avoid full `/creator` list fetch for incoming-call avatar fallback.
3. Add stronger endpoint-level rate limits for token-based web payment endpoints.
4. Consider dedicated workers for billing and webhook ingestion isolation.

## Validation Runbook (Pre-Release)

### A) Functional checks

- Auth: login/logout, token refresh, role-based route access (user/creator/admin/agent).
- Bonus: first claim succeeds once; retries are rejected with no duplicate credit.
- Payment: create-order -> verify success/fail/retry; duplicate verify calls do not double-credit.
- Referral: signup attach and late-attach constraints; purchase-triggered reward granted once.
- Support: enforce daily cap under concurrent submissions.
- Creator tasks: progress + claim consistency after call history updates.

### B) Load tests

- API load: `/auth/login`, `/user/me`, `/creator/dashboard`, `/payment/*`, `/support/*`.
- Realtime: socket connect/disconnect churn, presence updates, billing event fanout.
- Call simulation: sustain 50 active calls for at least 20-30 minutes; observe queue lag and settlement correctness.

### C) Pass/fail thresholds (recommended)

- P95 API latency:
  - Auth/core read endpoints: < 400ms
  - Dashboard/payment verify: < 800ms
- Error rate: < 1% non-4xx during steady load
- Billing queue lag (`zset_queue_lag_ms`): sustained < 1500ms
- Duplicate coin-credit incidents: zero
- Call settlement mismatches: zero

## Release Sign-Off Checklist

- [ ] P0 items deployed and verified in staging.
- [ ] Payment and referral idempotency tests pass (concurrent duplicate requests).
- [ ] Chat and video webhooks have signature verification and replay protections.
- [ ] Billing metrics dashboards visible (event loop lag, Redis write latency, queue lag, settlement failures).
- [ ] Creator dashboard query performance validated on production-like dataset.
- [ ] Incident rollback playbook prepared for payment/billing regression.

## Key Evidence References

- Auth defaults and guards:
  - `backend/src/modules/auth/auth.controller.ts`
  - `backend/src/middlewares/auth.middleware.ts`
  - `backend/src/server.ts`
- Payment and referral:
  - `backend/src/modules/payment/payment.routes.ts`
  - `backend/src/modules/payment/payment.controller.ts`
  - `backend/src/modules/user/referral.service.ts`
  - `backend/src/modules/user/user.controller.ts`
- Chat/video/billing:
  - `backend/src/modules/chat/chat.routes.ts`
  - `backend/src/modules/chat/chat.controller.ts`
  - `backend/src/modules/video/video.routes.ts`
  - `backend/src/modules/billing/billing.constants.ts`
  - `backend/src/modules/billing/billing-batch.processor.ts`
- Support/creator:
  - `backend/src/modules/support/support.controller.ts`
  - `backend/src/modules/creator/creator.controller.ts`
- Frontend UX/lifecycle:
  - `frontend/lib/app/widgets/app_lifecycle_wrapper.dart`
  - `frontend/lib/core/services/permission_prompt_service.dart`
  - `frontend/lib/features/home/screens/home_screen.dart`
  - `frontend/lib/app/widgets/stream_chat_wrapper.dart`
  - `frontend/lib/features/video/widgets/incoming_call_listener.dart`
  - `frontend/lib/core/api/api_client.dart`
  - `frontend/lib/features/auth/screens/otp_screen.dart`

## Final Verdict

Your architecture can support the requested scale with targeted hardening.  
Do not treat payment, webhook authentication, and billing concurrency as optional polish: these are the highest-impact reliability and financial-risk controls for going from current state to stable operation at `50` simultaneous calls and daily user growth.

