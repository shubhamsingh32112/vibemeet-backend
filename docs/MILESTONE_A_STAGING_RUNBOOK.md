# Milestone A Staging Runbook

Operational checklist after PR1 (P0 security) + PR2 (distributed locks) are merged.

## Pre-deploy

- [ ] Contract tests green in CI
- [ ] `billing-worker` desired count ≥ 2
- [ ] `DOMAIN_EVENTS_ENABLED=false` unless testing claim logic
- [ ] `BILLING_WATCHDOG_CLUSTER_LOCK=true`
- [ ] `PRESENCE_LOOKUP_AUTH_ENFORCED=true` (or staged rollout)

## Deploy

1. Build and push container image.
2. Rolling deploy `api-ws` and `billing-worker`.
3. Verify `/ready` on all tasks.

## Static validation

| Check | How |
|-------|-----|
| Socket billing auth | Unauthorized `call:started` → `billing:error` UNAUTHORIZED |
| VIP webhook | Razorpay test webhook → signature verified |
| `media:ready` | Stream upload → client on `user:{firebaseUid}` receives event |
| Presence lookup | Non-creator `user:availability:get` → FORBIDDEN |
| Watchdog singleton | Logs: one `lock.acquired` per interval across 2 billing-worker tasks |
| VIP recon | No duplicate `vip:scheduled_call:due` for same `scheduledCallId` |

## ECS rolling deploy safety (required)

Deploy **during** live activity:

- ≥2 active billed calls
- ≥5 creators online (WebSocket + heartbeat)
- BullMQ billing queue active/waiting

Roll both `api-ws` and `billing-worker` with `stopTimeout` ≥ 90s.

**Pass:**

- Calls survive or recover within one watchdog interval
- WS clients reconnect; creator presence stable (<30s spurious offline)
- BullMQ drains without unbounded growth
- Logs show `lock.released` on SIGTERM task and `lock.acquired` on survivor within one TTL
- No duplicate VIP emits or double settlements

**Fail (block signoff):** unsettled call drops, duplicate debits, orphaned `active:call:user:*`, dead task holds lock past 2× TTL.

## Redis disconnect simulation (required)

With active billing and ≥2 billing-worker tasks:

1. Restart ElastiCache primary **or** block Redis ~10–30s.
2. After recovery verify:
   - Watchdog `lock.acquired` on healthy replica
   - Billing ticks resume / reconciliation heals
   - No duplicate VIP emits
   - BullMQ + Socket.IO adapter reconnect
   - Re-run double-settlement assertion

## No double settlement assertion

```bash
tsx scripts/assert-no-double-settlement.ts
```

Must exit 0 before Milestone A signoff.

## Exit criteria

All sections above pass → Milestone A complete. **Do not start Phase 3** until stakeholder sign-off.
