# Billing settlement idempotency

`settleCall` in [`billing-settlement.service.ts`](../src/modules/billing/billing-settlement.service.ts) may be invoked concurrently from:

- Stream webhooks (`call.ended`, `call.session_ended`) via `settleCallHttp`
- Client `call:ended` (Socket.IO or REST)
- Socket **disconnect** auto-settle (`billing.gateway.ts`)
- Billing tick when balance hits zero or duration limit (`processBillingTick` → `settleCall`)

## Guarantees

1. **Redis `settled:call:{callId}`** — If present, settlement returns immediately (`Call already settled (Redis) — skipping`).

2. **Redis lock `settle:lock:{callId}`** — `SET NX EX 60` ensures only one settlement run executes Mongo/Redis cleanup at a time; concurrent callers log *Settlement already in progress / completed — skipping*.

3. **Order of operations** — `removeCallFromBilling` removes the call from `ACTIVE_BILLING_CALLS_KEY` first, then idempotency checks, so duplicate ticks do not double-settle.

4. **Mongo financial writes** — Coin debits/credits use deterministic keys (e.g. `transactionId: call_debit_${callId}`) so repeated attempts do not duplicate ledger rows when the transaction layer runs again (verify in `billing-settlement.service.ts` for your current `findOneAndUpdate` / upsert patterns).

## Operational checklist

- [ ] Alert on repeated `Settlement already in progress` for the same `callId` in a short window (may indicate client retry storms; usually harmless).
- [ ] Alert on `No session in Redis for settlement` when you expected a billable call (TTL expiry, or race with webhook).
- [ ] After deploy, spot-check one call: webhooks + client end + forced duplicate REST `call-ended` — balance moves once.

See also [VIDEO_CALL_AUTHORITY_MODEL.md](../../docs/VIDEO_CALL_AUTHORITY_MODEL.md).
