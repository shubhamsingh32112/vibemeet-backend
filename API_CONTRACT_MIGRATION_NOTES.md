# API Contract Migration Notes (Phase 2)

## Goal
- Stabilize response contracts without breaking existing clients.
- Keep legacy `data` payloads unchanged while introducing canonical `normalized` payloads.

## Rollout Strategy (Strangler)
1. **Parallel mode (current):** Backend returns legacy `data` plus `normalized` payload when:
   - `FF_NORMALIZED_RESPONSE_ADAPTER=true`, or
   - request header `x-api-response-shape: normalized|dual` is present.
2. **Client migration:** Mobile/admin clients start reading `normalized`.
3. **Traffic switch:** Enable `FF_NORMALIZED_RESPONSE_ADAPTER=true` in all environments.
4. **Legacy deprecation:** Remove legacy field usage after all clients are migrated.

## Canonical DTO Coverage
- Auth responses (`/auth/login`, `/auth/admin-login`)
- User profile (`/user/me`)
- Creator list/profile (`/creator`, `/creator/:id`)
- Wallet packages (`/payment/packages`)
- Payment verify (`/payment/verify`)

## Backward Compatibility
- Existing fields remain under `data`.
- New canonical contract is exposed under `normalized`.
- Deprecation guidance is exposed via `meta.deprecations`.

## Runtime Validation
- `normalized` payload is validated against zod schemas before response.
- Validation failures are logged and response safely falls back to legacy mode (no client break).

## Client Adoption Checklist
- Read from `normalized` first, fallback to `data` during migration window.
- Treat `meta.deprecations` as migration hints.
- Monitor headers:
  - `x-api-contract-version`
  - `x-api-response-mode`
  - `x-api-contract-validation`

## Rollback
- Set `FF_NORMALIZED_RESPONSE_ADAPTER=false` to disable normalized payload globally.
- Clients continue to work against legacy `data` response shape.
