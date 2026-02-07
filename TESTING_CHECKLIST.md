# PHASE 10 — Testing Checklist (MANDATORY)

## Video Call Billing Tests

### Test 1: 30 coins → call ends at exactly 30 seconds
**Setup:**
- User with exactly 30 coins
- Start a video call

**Expected:**
- Call runs for exactly 30 seconds
- User coins: 30 → 0 (1 coin per second)
- Creator earnings: 9 coins (30 * 0.3 = 9)
- Call auto-ends when coins reach 0
- `isForceEnded = true`
- `billedSeconds = 30`
- `userCoinsSpent = 30`
- `creatorCoinsEarned = 9`

**Verify:**
- Check call record in database
- Check user.coins = 0
- Check creator.earningsCoins increased by 9
- Check transaction records created

---

### Test 2: User with 9 coins → cannot start call
**Setup:**
- User with exactly 9 coins
- Attempt to start a video call

**Expected:**
- Backend returns 403 with error: `INSUFFICIENT_COINS_MIN_10`
- Frontend shows modal: "Minimum 10 coins required to start a call"
- Call is NOT created
- User coins remain at 9

**Verify:**
- Check API response
- Check frontend modal appears
- Check no call record created in database

---

## Chat Billing Tests

### Test 3: 3 free messages
**Setup:**
- New user (freeTextUsed = 0)
- Send 3 text messages

**Expected:**
- First 3 messages are free
- `freeTextUsed` increments: 0 → 1 → 2 → 3
- User coins unchanged
- Messages are sent successfully

**Verify:**
- Check user.freeTextUsed = 3 after 3 messages
- Check user.coins unchanged
- Check messages appear in chat

---

### Test 4: 4th message costs 5 coins
**Setup:**
- User with freeTextUsed = 3
- User with coins >= 5
- Send 4th text message

**Expected:**
- Message costs 5 coins
- User coins decrease by 5
- Transaction record created (type: 'debit', source: 'chat_message')
- Message is sent successfully

**Verify:**
- Check user.coins decreased by 5
- Check transaction record exists
- Check message appears in chat

---

### Test 5: Insufficient coins blocks message
**Setup:**
- User with freeTextUsed = 3 (all free messages used)
- User with coins < 5 (e.g., 3 coins)
- Attempt to send text message

**Expected:**
- Backend returns 403 with error: `INSUFFICIENT_COINS_CHAT`
- Frontend blocks input
- Frontend shows "Buy Coins" overlay
- Message is NOT sent
- User coins unchanged

**Verify:**
- Check API response (403, error: INSUFFICIENT_COINS_CHAT)
- Check frontend input is disabled
- Check "Buy Coins" overlay appears
- Check no message sent
- Check user.coins unchanged

---

## Creator Earnings Tests

### Test 6: 60 seconds → 18 coins
**Setup:**
- User with >= 60 coins
- Start video call
- Let call run for exactly 60 seconds
- End call normally

**Expected:**
- Call duration: 60 seconds
- User coins: decreased by 60 (1 coin per second)
- Creator earnings: increased by 18 coins (60 * 0.3 = 18)
- `billedSeconds = 60`
- `userCoinsSpent = 60`
- `creatorCoinsEarned = 18`

**Verify:**
- Check call record: billedSeconds = 60
- Check call record: creatorCoinsEarned = 18
- Check creator.earningsCoins increased by 18
- Check user.coins decreased by 60

---

## Multi-Call Fairness Test

### Test 7: 30 coins → 2 creators for 15 seconds each
**Setup:**
- User with exactly 30 coins
- Start call with Creator A
- After 15 seconds, start call with Creator B (in another tab/device)
- Both calls should run simultaneously

**Expected:**
- Both calls bill independently
- Each call deducts 1 coin per second
- After 15 seconds:
  - Call A: 15 coins spent, Creator A earned 4.5 coins
  - Call B: 15 coins spent, Creator B earned 4.5 coins
  - Total: 30 coins spent (user has 0 coins)
- Both calls auto-end when coins reach 0

**Verify:**
- Check both calls have independent billing loops
- Check both calls end when coins reach 0
- Check total coins spent = 30
- Check both creators earned their share

---

## Safety Guards Tests

### Test 8: Coin balance floor = 0 (never negative)
**Setup:**
- User with 1 coin
- Start call
- Let call run

**Expected:**
- After 1 second: user.coins = 0
- Call auto-ends
- User.coins never goes negative
- `user.coins = 0` (not -1, not -2, etc.)

**Verify:**
- Check user.coins = 0 (not negative)
- Check Math.max(0, ...) is applied in billing

---

### Test 9: Billing heartbeat watchdog
**Setup:**
- Start a call
- Simulate billing loop crash (kill process, network error, etc.)

**Expected:**
- Watchdog detects no heartbeat for 10 seconds
- Watchdog force-ends the call
- Call marked as ended
- No infinite billing

**Verify:**
- Check watchdog detects stuck billing
- Check call is force-ended
- Check billing stops

---

### Test 10: Webhook idempotency
**Setup:**
- Start a call
- Receive `call.session_started` webhook twice (simulate duplicate)

**Expected:**
- First webhook: starts billing
- Second webhook: detects billing already started, skips (idempotent)
- Only one billing loop per call

**Verify:**
- Check only one billing interval exists
- Check logs show "idempotent" message
- Check billing happens only once

---

## Error Contract Tests

### Test 11: Standardized error codes
**Test cases:**
1. Call initiation with < 10 coins → `INSUFFICIENT_COINS_MIN_10`
2. Chat message with insufficient coins → `INSUFFICIENT_COINS_CHAT`
3. Call force-ended due to coins → `INSUFFICIENT_COINS_CALL` (in disconnect reason)

**Expected:**
- All errors use standardized codes
- Frontend shows "Buy Coins" modal for all insufficient coin errors
- Never silently fail

**Verify:**
- Check error codes match specification
- Check frontend modal appears
- Check user is never left confused

---

## Manual Testing Steps

1. **Start backend server**
2. **Start frontend app**
3. **Create test user** (gets 30 free coins)
4. **Run each test case above**
5. **Verify database records**
6. **Verify frontend UI behavior**
7. **Check logs for errors**

---

## Automated Testing (Future)

Consider adding:
- Unit tests for billing logic
- Integration tests for webhook handlers
- E2E tests for call flow
- E2E tests for chat flow
