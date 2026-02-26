# Billing Hardening Phase 3 Notes

## Strangler Rollout
- Keep legacy billing gateway flow as source of truth.
- Run new `BillingDomainService` in **shadow mode** only.
- Compare legacy settlement vs shadow settlement outputs and emit report logs.

## Feature Flags
- `FF_BILLING_DOMAIN_SHADOW_MODE` (default `false`)
  - Enables shadow session tracking, Redis lease tick coordination, settlement comparison and metrics.
- `FF_BILLING_DOMAIN_CUTOVER` (default `false`)
  - Reserved cutover control flag for future source-of-truth switch.

## Redis-backed Coordination
- Shadow session state: `billing:shadow:session:{callId}`
- Tick lease lock: `billing:shadow:lease:{callId}`
- Durable settlement lock: `billing:shadow:settle_lock:{callId}`
- Settlement audit record: `billing:shadow:settle_audit:{callId}`
- Comparison report: `billing:shadow:report:{callId}`

## Metrics Keys
- `billing:metrics:settlement_attempts`
- `billing:metrics:settlement_conflicts`
- `billing:metrics:settlement_duration`
- `billing:metrics:balance_mismatch_count`

## Shadow Report Output
- Structured log event: `billing.shadow.comparison_report`
- Includes:
  - elapsed seconds (legacy vs shadow)
  - final coins (legacy vs shadow)
  - total deducted (legacy vs shadow)
  - final earnings (legacy vs shadow)
  - mismatch fields

## Rollback
1. Set `FF_BILLING_DOMAIN_SHADOW_MODE=false`.
2. Redeploy backend (legacy billing continues unchanged).
3. If needed, revert `billing-domain.service.ts` and gateway shadow hooks; no client contract changes are involved.
