# Identity Ledger — Welcome Bonus Abuse Prevention

## Overview

The Identity Ledger enforces **one welcome bonus per identity**, where identity is defined as:

- `deviceFingerprint` (Fast Login)
- `googleId` (Firebase UID for Google/Phone auth, excludes `fast_` prefix)
- `phone`

This prevents users from deleting their account and reinstalling the app to reclaim the welcome bonus.

---

## Implementation Summary

### 1. IdentityLedger Collection

**File:** `src/modules/user/identity-ledger.model.ts`

| Field | Type | Notes |
|-------|------|-------|
| deviceFingerprint | string (optional) | Sparse index |
| googleId | string (optional) | Sparse index |
| phone | string (optional) | Sparse index |
| bonusClaimed | boolean | Always true |
| firstUserId | ObjectId | Reference to first user who claimed |
| createdAt, updatedAt | Date | Timestamps |

**Indexes:**
- Sparse: `{ deviceFingerprint: 1 }`, `{ googleId: 1 }`, `{ phone: 1 }`
- Compound (for `$or` + `bonusClaimed: true` queries):  
  `{ deviceFingerprint: 1, bonusClaimed: 1 }`, `{ googleId: 1, bonusClaimed: 1 }`, `{ phone: 1, bonusClaimed: 1 }`

**Rules:**
- Records are never deleted (even on account deletion)
- Compound indexes speed up eligibility checks as the table grows

### 2. Identity Service

**File:** `src/modules/user/identity.service.ts`

| Function | Purpose |
|----------|---------|
| `checkBonusEligibility(input)` | Returns `true` if identity has not claimed bonus |
| `tryClaimBonusInLedger(input)` | **Atomic** upsert — only first request succeeds; concurrent requests get `false` |
| `recordBonusClaim(input)` | @deprecated — used by migration/backfill only |

**Race condition handling:** `tryClaimBonusInLedger` uses `updateOne` with `$setOnInsert` and `upsert: true`. Filter matches docs where identity exists and `bonusClaimed: true`. If no match → insert (win). If match → no insert (lose). Only `upsertedCount === 1` means the claim succeeded.

### 3. Login Flow Integration

**auth.controller.ts**

- **login()** — For new users: passes **all identities we know** to `checkBonusEligibility`:
  - `deviceFingerprint` (optional, from `req.body` — client sends when available)
  - `googleId` (Firebase UID when not Fast Login)
  - `phone` (from `req.auth`)
- **fastLogin()** — For new users: passes `deviceFingerprint` (only identity available for Fast Login)

**Stronger check:** Always pass all identities. Users can sign in with Google, delete, then sign in with Fast Login; if we only check the login identity, the bonus could be bypassed. Passing `deviceFingerprint` on login (when client sends it) prevents this.

**Frontend (auth_provider.dart):** `POST /auth/login` includes optional `deviceFingerprint` in body when Fast Login is allowed (real device). Omitted on emulators.

### 4. Welcome Bonus Claim

**user.controller.ts** — `claimWelcomeBonus()`

- Calls `tryClaimBonusInLedger` **first** (atomic claim). If it returns `false`, rejects.
- Only if it returns `true`, grants coins and updates user. No separate `recordBonusClaim` — the atomic upsert records the claim.

### 5. Account Deletion

**Unchanged** — `deleteAccount` does NOT touch IdentityLedger. Ledger records persist.

---

## Backward Compatibility

- Existing users with `welcomeBonusClaimed: true` are not in the ledger.
- **Run the backfill script** after deployment to prevent them from reclaiming after delete+reinstall:

```bash
npm run migrate:identity-ledger
```

---

## Scale

- Sparse indexes + compound indexes on `(field, bonusClaimed)` for fast `$or` lookups
- Atomic `updateOne` with upsert for race-free bonus claims
- Ledger writes only on bonus claim (low volume)
- Suitable for 1000 users/day, 200 creators

---

## Files Changed/Created

| File | Change |
|------|--------|
| `modules/user/identity-ledger.model.ts` | IdentityLedger schema; sparse + compound indexes |
| `modules/user/identity.service.ts` | `checkBonusEligibility`, `tryClaimBonusInLedger` (atomic), `recordBonusClaim` (deprecated) |
| `modules/auth/auth.controller.ts` | login(), fastLogin() — pass all identities; login accepts optional `deviceFingerprint` in body |
| `modules/user/user.controller.ts` | claimWelcomeBonus() — atomic `tryClaimBonusInLedger` only |
| `frontend/.../auth_provider.dart` | POST /auth/login sends optional `deviceFingerprint` when available |
| `scripts/backfill-identity-ledger.ts` | One-time migration for existing users |
| `package.json` | `migrate:identity-ledger` script |
