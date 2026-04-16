# Batch 2: Creator Promotion Bonus Reversal Ledger Entry

## What changed

### Backend: centralized and idempotent bonus-reversal transaction writer
- Updated `backend/src/modules/creator/creator-starter.service.ts`:
  - Added `CREATOR_PROMOTION_BONUS_REVERSAL_COINS = 30`.
  - Added deterministic transaction id helper:
    - `creatorPromotionBonusReversalTransactionId(userId)`.
  - Added idempotent upsert writer:
    - `ensureCreatorPromotionBonusReversalEntry(user, session?)`.
  - Promotion helper now calls this writer in the same session transaction path.

### Backend: applied to all active promotion entry points
- Updated `backend/src/modules/user/user.controller.ts` (`promoteToCreator`):
  - After user save (role + coin reset), call `ensureCreatorPromotionBonusReversalEntry(targetUser, session)`.
- Updated `backend/src/modules/agent/agent.controller.ts` (`postAgentCreateCreator`):
  - After user save (role + coin reset), call `ensureCreatorPromotionBonusReversalEntry(targetUser, session)`.
- Updated `backend/src/modules/creator/creator.controller.ts` (`createCreator`):
  - Converted the flow to use a Mongo session transaction.
  - Promotion semantics now also set `welcomeBonusClaimed = true`, clear coins, and insert the fixed `-30` debit entry through the same idempotent helper.

## Why
- Promotion flows were clearing coins but not creating a `CoinTransaction` record.
- Transaction pages read from `CoinTransaction`, so creators could not see the bonus removal.
- A deterministic transaction id + upsert ensures retry-safe idempotency and prevents duplicate rows.

## Transaction semantics
- Entry type: `debit`
- Entry amount: fixed `30`
- Source: `admin` (schema-compatible existing enum)
- Description: `Welcome bonus reversal on creator promotion (-30 coins)`
- Insert semantics: `updateOne(..., { upsert: true, $setOnInsert: ... })` in transaction/session context.

## Scalability impact
- Adds one append-style logical transaction write per promotion event.
- No new feed query patterns, no polling, no hot-path read amplification.
- Existing `CoinTransaction` indexes remain sufficient for transaction history retrieval.

## Verification checklist
- [ ] Promote a user to creator via admin endpoint and confirm one `-30` debit appears.
- [ ] Create a creator via `POST /creator` and confirm one `-30` debit appears.
- [ ] Promote via agent flow and confirm one `-30` debit appears.
- [ ] Retry duplicate promotion request and confirm no duplicate debit row (idempotent).
- [ ] Confirm creator transaction API response shape is unchanged.

## Rollback
- Revert helper insertion calls in `user.controller.ts`, `agent.controller.ts`, and `creator.controller.ts`.
- Revert helper additions in `creator-starter.service.ts`.
- No schema migration required for rollback.

