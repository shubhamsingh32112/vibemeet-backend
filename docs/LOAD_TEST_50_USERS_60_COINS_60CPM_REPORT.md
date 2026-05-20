# Load test: 50 concurrent billing @ 60 coins, 60 CPM

**Generated:** 2026-05-18T18:44:17.340Z
**Harness:** socket-force-end-test.mjs
**JSON:** `force-end-multi-results-2026-05-18T18-44-17-340Z.json`

## Configuration

| Parameter | Value |
|-----------|--------|
| Concurrent sessions | 50 |
| Fan coins (seed) | 60 |
| Creator price (coins/min) | 60 |
| Expected duration | ~60.0 s |
| BASE_URL | http://127.0.0.1:3000 |

## Duration statistics

| Metric | Value (seconds) |
|--------|-----------------|
| Count | 50 |
| Min | 58.504 |
| Max | 58.782 |
| Mean | 58.612 |
| Median | 58.572 |
| Std dev | 0.088 |

## Per-session summary

| User | Fan email | CPM | call-started (ISO) | force-end (ISO) | Duration (s) | Skew vs expected | Remaining | Auto-ended |
|------|-----------|-----|----------------------|-----------------|--------------|------------------|-----------|------------|
| 1 | loadtest_fan_1@loadtest.local | 60 | 2026-05-18T18:43:17.179Z | 2026-05-18T18:44:15.961Z | 58.782 | -1.218 | 0 | yes | insufficient_coins |
| 2 | loadtest_fan_2@loadtest.local | 60 | 2026-05-18T18:43:18.776Z | 2026-05-18T18:44:17.321Z | 58.545 | -1.455 | 0 | yes | insufficient_coins |
| 3 | loadtest_fan_3@loadtest.local | 60 | 2026-05-18T18:43:17.744Z | 2026-05-18T18:44:16.436Z | 58.692 | -1.308 | 0 | yes | insufficient_coins |
| 4 | loadtest_fan_4@loadtest.local | 60 | 2026-05-18T18:43:17.745Z | 2026-05-18T18:44:16.440Z | 58.695 | -1.305 | 0 | yes | insufficient_coins |
| 5 | loadtest_fan_5@loadtest.local | 60 | 2026-05-18T18:43:18.746Z | 2026-05-18T18:44:17.321Z | 58.575 | -1.425 | 0 | yes | insufficient_coins |
| 6 | loadtest_fan_6@loadtest.local | 60 | 2026-05-18T18:43:17.912Z | 2026-05-18T18:44:16.436Z | 58.524 | -1.476 | 0 | yes | insufficient_coins |
| 7 | loadtest_fan_7@loadtest.local | 60 | 2026-05-18T18:43:18.772Z | 2026-05-18T18:44:17.325Z | 58.553 | -1.447 | 0 | yes | insufficient_coins |
| 8 | loadtest_fan_8@loadtest.local | 60 | 2026-05-18T18:43:17.916Z | 2026-05-18T18:44:16.440Z | 58.524 | -1.476 | 0 | yes | insufficient_coins |
| 9 | loadtest_fan_9@loadtest.local | 60 | 2026-05-18T18:43:17.912Z | 2026-05-18T18:44:16.435Z | 58.523 | -1.477 | 0 | yes | insufficient_coins |
| 10 | loadtest_fan_10@loadtest.local | 60 | 2026-05-18T18:43:17.856Z | 2026-05-18T18:44:16.440Z | 58.584 | -1.416 | 0 | yes | insufficient_coins |
| 11 | loadtest_fan_11@loadtest.local | 60 | 2026-05-18T18:43:18.776Z | 2026-05-18T18:44:17.322Z | 58.546 | -1.454 | 0 | yes | insufficient_coins |
| 12 | loadtest_fan_12@loadtest.local | 60 | 2026-05-18T18:43:17.743Z | 2026-05-18T18:44:16.442Z | 58.699 | -1.301 | 0 | yes | insufficient_coins |
| 13 | loadtest_fan_13@loadtest.local | 60 | 2026-05-18T18:43:18.746Z | 2026-05-18T18:44:17.325Z | 58.579 | -1.421 | 0 | yes | insufficient_coins |
| 14 | loadtest_fan_14@loadtest.local | 60 | 2026-05-18T18:43:17.911Z | 2026-05-18T18:44:16.435Z | 58.524 | -1.476 | 0 | yes | insufficient_coins |
| 15 | loadtest_fan_15@loadtest.local | 60 | 2026-05-18T18:43:18.704Z | 2026-05-18T18:44:17.326Z | 58.622 | -1.378 | 0 | yes | insufficient_coins |
| 16 | loadtest_fan_16@loadtest.local | 60 | 2026-05-18T18:43:17.744Z | 2026-05-18T18:44:16.435Z | 58.691 | -1.309 | 0 | yes | insufficient_coins |
| 17 | loadtest_fan_17@loadtest.local | 60 | 2026-05-18T18:43:17.179Z | 2026-05-18T18:44:15.955Z | 58.776 | -1.224 | 0 | yes | insufficient_coins |
| 18 | loadtest_fan_18@loadtest.local | 60 | 2026-05-18T18:43:17.700Z | 2026-05-18T18:44:16.422Z | 58.722 | -1.278 | 0 | yes | insufficient_coins |
| 19 | loadtest_fan_19@loadtest.local | 60 | 2026-05-18T18:43:17.856Z | 2026-05-18T18:44:16.441Z | 58.585 | -1.415 | 0 | yes | insufficient_coins |
| 20 | loadtest_fan_20@loadtest.local | 60 | 2026-05-18T18:43:17.745Z | 2026-05-18T18:44:16.440Z | 58.695 | -1.305 | 0 | yes | insufficient_coins |
| 21 | loadtest_fan_21@loadtest.local | 60 | 2026-05-18T18:43:18.746Z | 2026-05-18T18:44:17.311Z | 58.565 | -1.435 | 0 | yes | insufficient_coins |
| 22 | loadtest_fan_22@loadtest.local | 60 | 2026-05-18T18:43:18.776Z | 2026-05-18T18:44:17.321Z | 58.545 | -1.455 | 0 | yes | insufficient_coins |
| 23 | loadtest_fan_23@loadtest.local | 60 | 2026-05-18T18:43:17.695Z | 2026-05-18T18:44:16.441Z | 58.746 | -1.254 | 0 | yes | insufficient_coins |
| 24 | loadtest_fan_24@loadtest.local | 60 | 2026-05-18T18:43:18.776Z | 2026-05-18T18:44:17.338Z | 58.562 | -1.438 | 0 | yes | insufficient_coins |
| 25 | loadtest_fan_25@loadtest.local | 60 | 2026-05-18T18:43:17.912Z | 2026-05-18T18:44:16.432Z | 58.520 | -1.480 | 0 | yes | insufficient_coins |
| 26 | loadtest_fan_26@loadtest.local | 60 | 2026-05-18T18:43:17.742Z | 2026-05-18T18:44:16.431Z | 58.689 | -1.311 | 0 | yes | insufficient_coins |
| 27 | loadtest_fan_27@loadtest.local | 60 | 2026-05-18T18:43:18.747Z | 2026-05-18T18:44:17.325Z | 58.578 | -1.422 | 0 | yes | insufficient_coins |
| 28 | loadtest_fan_28@loadtest.local | 60 | 2026-05-18T18:43:17.914Z | 2026-05-18T18:44:16.441Z | 58.527 | -1.473 | 0 | yes | insufficient_coins |
| 29 | loadtest_fan_29@loadtest.local | 60 | 2026-05-18T18:43:17.870Z | 2026-05-18T18:44:16.436Z | 58.566 | -1.434 | 0 | yes | insufficient_coins |
| 30 | loadtest_fan_30@loadtest.local | 60 | 2026-05-18T18:43:18.775Z | 2026-05-18T18:44:17.323Z | 58.548 | -1.452 | 0 | yes | insufficient_coins |
| 31 | loadtest_fan_31@loadtest.local | 60 | 2026-05-18T18:43:18.819Z | 2026-05-18T18:44:17.323Z | 58.504 | -1.496 | 0 | yes | insufficient_coins |
| 32 | loadtest_fan_32@loadtest.local | 60 | 2026-05-18T18:43:18.775Z | 2026-05-18T18:44:17.320Z | 58.545 | -1.455 | 0 | yes | insufficient_coins |
| 33 | loadtest_fan_33@loadtest.local | 60 | 2026-05-18T18:43:18.771Z | 2026-05-18T18:44:17.314Z | 58.543 | -1.457 | 0 | yes | insufficient_coins |
| 34 | loadtest_fan_34@loadtest.local | 60 | 2026-05-18T18:43:17.175Z | 2026-05-18T18:44:15.957Z | 58.782 | -1.218 | 0 | yes | insufficient_coins |
| 35 | loadtest_fan_35@loadtest.local | 60 | 2026-05-18T18:43:17.176Z | 2026-05-18T18:44:15.957Z | 58.781 | -1.219 | 0 | yes | insufficient_coins |
| 36 | loadtest_fan_36@loadtest.local | 60 | 2026-05-18T18:43:17.743Z | 2026-05-18T18:44:16.432Z | 58.689 | -1.311 | 0 | yes | insufficient_coins |
| 37 | loadtest_fan_37@loadtest.local | 60 | 2026-05-18T18:43:18.771Z | 2026-05-18T18:44:17.311Z | 58.540 | -1.460 | 0 | yes | insufficient_coins |
| 38 | loadtest_fan_38@loadtest.local | 60 | 2026-05-18T18:43:18.774Z | 2026-05-18T18:44:17.320Z | 58.546 | -1.454 | 0 | yes | insufficient_coins |
| 39 | loadtest_fan_39@loadtest.local | 60 | 2026-05-18T18:43:18.775Z | 2026-05-18T18:44:17.324Z | 58.549 | -1.451 | 0 | yes | insufficient_coins |
| 40 | loadtest_fan_40@loadtest.local | 60 | 2026-05-18T18:43:17.699Z | 2026-05-18T18:44:16.435Z | 58.736 | -1.264 | 0 | yes | insufficient_coins |
| 41 | loadtest_fan_41@loadtest.local | 60 | 2026-05-18T18:43:18.747Z | 2026-05-18T18:44:17.321Z | 58.574 | -1.426 | 0 | yes | insufficient_coins |
| 42 | loadtest_fan_42@loadtest.local | 60 | 2026-05-18T18:43:18.774Z | 2026-05-18T18:44:17.338Z | 58.564 | -1.436 | 0 | yes | insufficient_coins |
| 43 | loadtest_fan_43@loadtest.local | 60 | 2026-05-18T18:43:18.777Z | 2026-05-18T18:44:17.325Z | 58.548 | -1.452 | 0 | yes | insufficient_coins |
| 44 | loadtest_fan_44@loadtest.local | 60 | 2026-05-18T18:43:17.856Z | 2026-05-18T18:44:16.441Z | 58.585 | -1.415 | 0 | yes | insufficient_coins |
| 45 | loadtest_fan_45@loadtest.local | 60 | 2026-05-18T18:43:17.182Z | 2026-05-18T18:44:15.960Z | 58.778 | -1.222 | 0 | yes | insufficient_coins |
| 46 | loadtest_fan_46@loadtest.local | 60 | 2026-05-18T18:43:18.775Z | 2026-05-18T18:44:17.320Z | 58.545 | -1.455 | 0 | yes | insufficient_coins |
| 47 | loadtest_fan_47@loadtest.local | 60 | 2026-05-18T18:43:17.744Z | 2026-05-18T18:44:16.442Z | 58.698 | -1.302 | 0 | yes | insufficient_coins |
| 48 | loadtest_fan_48@loadtest.local | 60 | 2026-05-18T18:43:18.747Z | 2026-05-18T18:44:17.318Z | 58.571 | -1.429 | 0 | yes | insufficient_coins |
| 49 | loadtest_fan_49@loadtest.local | 60 | 2026-05-18T18:43:17.911Z | 2026-05-18T18:44:16.442Z | 58.531 | -1.469 | 0 | yes | insufficient_coins |
| 50 | loadtest_fan_50@loadtest.local | 60 | 2026-05-18T18:43:17.699Z | 2026-05-18T18:44:16.430Z | 58.731 | -1.269 | 0 | yes | insufficient_coins |

## Per-user detail logs

### User 1 — loadtest_fan_1@loadtest.local

- callId: `jxbsrjVPPJdVczrbCHm5E3iXIp92_6a0b5d3ee33290ae92689ca9_1779129796375`
- workerStartedAt: 2026-05-18T18:43:15.246Z
- socketConnectedAt: 2026-05-18T18:43:16.375Z
- billingRestStartedAt: 2026-05-18T18:43:17.179Z
- billingStartedEventAt: 2026-05-18T18:43:16.947Z
- lastBillingUpdateAt: 2026-05-18T18:44:15.960Z
- forceEndAt: 2026-05-18T18:44:15.961Z
- durationSec: 58.782 (skew: -1.218 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 2 — loadtest_fan_2@loadtest.local

- callId: `OLTBgHwR44amDpxRYgQrhvySuPl1_6a0b5d41e33290ae92689cb2_1779129796668`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.668Z
- billingRestStartedAt: 2026-05-18T18:43:18.776Z
- billingStartedEventAt: 2026-05-18T18:43:18.528Z
- lastBillingUpdateAt: 2026-05-18T18:44:17.319Z
- forceEndAt: 2026-05-18T18:44:17.321Z
- durationSec: 58.545 (skew: -1.455 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 3 — loadtest_fan_3@loadtest.local

- callId: `PeoAuiQqzYfAm5q9N7OwJ2UNdn13_6a0b5d43e33290ae92689cbb_1779129796401`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.401Z
- billingRestStartedAt: 2026-05-18T18:43:17.744Z
- billingStartedEventAt: 2026-05-18T18:43:17.509Z
- lastBillingUpdateAt: 2026-05-18T18:44:16.434Z
- forceEndAt: 2026-05-18T18:44:16.436Z
- durationSec: 58.692 (skew: -1.308 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 4 — loadtest_fan_4@loadtest.local

- callId: `dwizbTDmE1YAovLYMAqTDDGatHD3_6a0b5d46e33290ae92689cc4_1779129796403`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.403Z
- billingRestStartedAt: 2026-05-18T18:43:17.745Z
- billingStartedEventAt: 2026-05-18T18:43:17.510Z
- lastBillingUpdateAt: 2026-05-18T18:44:16.438Z
- forceEndAt: 2026-05-18T18:44:16.440Z
- durationSec: 58.695 (skew: -1.305 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 5 — loadtest_fan_5@loadtest.local

- callId: `KjfPixoRbMYtsUiKREtK0Wytvs53_6a0b5d48e33290ae92689ccd_1779129796520`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.520Z
- billingRestStartedAt: 2026-05-18T18:43:18.746Z
- billingStartedEventAt: 2026-05-18T18:43:18.467Z
- lastBillingUpdateAt: 2026-05-18T18:44:17.319Z
- forceEndAt: 2026-05-18T18:44:17.321Z
- durationSec: 58.575 (skew: -1.425 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 6 — loadtest_fan_6@loadtest.local

- callId: `OdXAurptfeWQ5pnkRIgG5IiyEnz1_6a0b5d4be33290ae92689cd6_1779129796504`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.504Z
- billingRestStartedAt: 2026-05-18T18:43:17.912Z
- billingStartedEventAt: 2026-05-18T18:43:17.678Z
- lastBillingUpdateAt: 2026-05-18T18:44:16.434Z
- forceEndAt: 2026-05-18T18:44:16.436Z
- durationSec: 58.524 (skew: -1.476 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 7 — loadtest_fan_7@loadtest.local

- callId: `aqq5JSNYdqRv5OUWvgZ8FhhrbHk1_6a0b5d4de33290ae92689cdf_1779129796513`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.513Z
- billingRestStartedAt: 2026-05-18T18:43:18.772Z
- billingStartedEventAt: 2026-05-18T18:43:18.517Z
- lastBillingUpdateAt: 2026-05-18T18:44:17.324Z
- forceEndAt: 2026-05-18T18:44:17.325Z
- durationSec: 58.553 (skew: -1.447 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 8 — loadtest_fan_8@loadtest.local

- callId: `S9b4LOyN38XAQJQ051JN1Bhkt6D3_6a0b5d50e33290ae92689ce8_1779129796506`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.506Z
- billingRestStartedAt: 2026-05-18T18:43:17.916Z
- billingStartedEventAt: 2026-05-18T18:43:17.680Z
- lastBillingUpdateAt: 2026-05-18T18:44:16.436Z
- forceEndAt: 2026-05-18T18:44:16.440Z
- durationSec: 58.524 (skew: -1.476 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 9 — loadtest_fan_9@loadtest.local

- callId: `Fm3ELpoCU6havvtFUsoxn3TibNl2_6a0b5d52e33290ae92689cf1_1779129796498`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.498Z
- billingRestStartedAt: 2026-05-18T18:43:17.912Z
- billingStartedEventAt: 2026-05-18T18:43:17.677Z
- lastBillingUpdateAt: 2026-05-18T18:44:16.433Z
- forceEndAt: 2026-05-18T18:44:16.435Z
- durationSec: 58.523 (skew: -1.477 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 10 — loadtest_fan_10@loadtest.local

- callId: `VFNqJ6O4e1Vt6FQ1kgVEqsUXDA93_6a0b5d55e33290ae92689cfa_1779129796414`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.414Z
- billingRestStartedAt: 2026-05-18T18:43:17.856Z
- billingStartedEventAt: 2026-05-18T18:43:17.620Z
- lastBillingUpdateAt: 2026-05-18T18:44:16.437Z
- forceEndAt: 2026-05-18T18:44:16.440Z
- durationSec: 58.584 (skew: -1.416 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 11 — loadtest_fan_11@loadtest.local

- callId: `T6BLVQtQtBPaOwtQPxzmipsv7rZ2_6a0b5d57e33290ae92689d03_1779129796594`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.593Z
- billingRestStartedAt: 2026-05-18T18:43:18.776Z
- billingStartedEventAt: 2026-05-18T18:43:18.523Z
- lastBillingUpdateAt: 2026-05-18T18:44:17.320Z
- forceEndAt: 2026-05-18T18:44:17.322Z
- durationSec: 58.546 (skew: -1.454 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 12 — loadtest_fan_12@loadtest.local

- callId: `uiufYmrIbdau3e60c0mtnYWLtkn1_6a0b5d5ae33290ae92689d0c_1779129796383`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.383Z
- billingRestStartedAt: 2026-05-18T18:43:17.743Z
- billingStartedEventAt: 2026-05-18T18:43:17.503Z
- lastBillingUpdateAt: 2026-05-18T18:44:16.442Z
- forceEndAt: 2026-05-18T18:44:16.442Z
- durationSec: 58.699 (skew: -1.301 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 13 — loadtest_fan_13@loadtest.local

- callId: `hZRXUDP2qdauXfYGCcUbELbVmAM2_6a0b5d5ce33290ae92689d15_1779129796508`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.508Z
- billingRestStartedAt: 2026-05-18T18:43:18.746Z
- billingStartedEventAt: 2026-05-18T18:43:18.464Z
- lastBillingUpdateAt: 2026-05-18T18:44:17.324Z
- forceEndAt: 2026-05-18T18:44:17.325Z
- durationSec: 58.579 (skew: -1.421 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 14 — loadtest_fan_14@loadtest.local

- callId: `FVK3xfTi0WYfSj7yAxV3uqckUvr2_6a0b5d5fe33290ae92689d1e_1779129796495`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.495Z
- billingRestStartedAt: 2026-05-18T18:43:17.911Z
- billingStartedEventAt: 2026-05-18T18:43:17.674Z
- lastBillingUpdateAt: 2026-05-18T18:44:16.433Z
- forceEndAt: 2026-05-18T18:44:16.435Z
- durationSec: 58.524 (skew: -1.476 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 15 — loadtest_fan_15@loadtest.local

- callId: `pekWxgyWw3e2v8OCoB6Ye1qmvzo1_6a0b5d61e33290ae92689d27_1779129796510`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.510Z
- billingRestStartedAt: 2026-05-18T18:43:18.704Z
- billingStartedEventAt: 2026-05-18T18:43:18.462Z
- lastBillingUpdateAt: 2026-05-18T18:44:17.324Z
- forceEndAt: 2026-05-18T18:44:17.326Z
- durationSec: 58.622 (skew: -1.378 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 16 — loadtest_fan_16@loadtest.local

- callId: `Np4wwUvR7WZVasNn0Bb0T4DLhdm2_6a0b5d63e33290ae92689d30_1779129796381`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.381Z
- billingRestStartedAt: 2026-05-18T18:43:17.744Z
- billingStartedEventAt: 2026-05-18T18:43:17.508Z
- lastBillingUpdateAt: 2026-05-18T18:44:16.433Z
- forceEndAt: 2026-05-18T18:44:16.435Z
- durationSec: 58.691 (skew: -1.309 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 17 — loadtest_fan_17@loadtest.local

- callId: `09a5dw9GS1PdollKwUOwNkVyoqN2_6a0b5d66e33290ae92689d39_1779129796333`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.333Z
- billingRestStartedAt: 2026-05-18T18:43:17.179Z
- billingStartedEventAt: 2026-05-18T18:43:16.946Z
- lastBillingUpdateAt: 2026-05-18T18:44:15.955Z
- forceEndAt: 2026-05-18T18:44:15.955Z
- durationSec: 58.776 (skew: -1.224 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 18 — loadtest_fan_18@loadtest.local

- callId: `2If66qqVece2dmi4KDjjqwWE2tu1_6a0b5d68e33290ae92689d42_1779129796356`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.356Z
- billingRestStartedAt: 2026-05-18T18:43:17.700Z
- billingStartedEventAt: 2026-05-18T18:43:17.468Z
- lastBillingUpdateAt: 2026-05-18T18:44:16.421Z
- forceEndAt: 2026-05-18T18:44:16.422Z
- durationSec: 58.722 (skew: -1.278 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 19 — loadtest_fan_19@loadtest.local

- callId: `zTuq14k75IQgY4GBbGzgtXb5eXr1_6a0b5d6be33290ae92689d4b_1779129796419`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.419Z
- billingRestStartedAt: 2026-05-18T18:43:17.856Z
- billingStartedEventAt: 2026-05-18T18:43:17.624Z
- lastBillingUpdateAt: 2026-05-18T18:44:16.439Z
- forceEndAt: 2026-05-18T18:44:16.441Z
- durationSec: 58.585 (skew: -1.415 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 20 — loadtest_fan_20@loadtest.local

- callId: `kFZ8g2qZbPS1A8qlv6c9AS2i2I13_6a0b5d6de33290ae92689d54_1779129796405`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.405Z
- billingRestStartedAt: 2026-05-18T18:43:17.745Z
- billingStartedEventAt: 2026-05-18T18:43:17.511Z
- lastBillingUpdateAt: 2026-05-18T18:44:16.438Z
- forceEndAt: 2026-05-18T18:44:16.440Z
- durationSec: 58.695 (skew: -1.305 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 21 — loadtest_fan_21@loadtest.local

- callId: `2zYd8xH1GXh80wjvEEi8sJTAyyC2_6a0b5d70e33290ae92689d5d_1779129796501`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.501Z
- billingRestStartedAt: 2026-05-18T18:43:18.746Z
- billingStartedEventAt: 2026-05-18T18:43:18.466Z
- lastBillingUpdateAt: 2026-05-18T18:44:17.311Z
- forceEndAt: 2026-05-18T18:44:17.311Z
- durationSec: 58.565 (skew: -1.435 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 22 — loadtest_fan_22@loadtest.local

- callId: `S8crN8VwJkbCsFFcDLfq094SCL42_6a0b5d72e33290ae92689d66_1779129796595`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.595Z
- billingRestStartedAt: 2026-05-18T18:43:18.776Z
- billingStartedEventAt: 2026-05-18T18:43:18.524Z
- lastBillingUpdateAt: 2026-05-18T18:44:17.319Z
- forceEndAt: 2026-05-18T18:44:17.321Z
- durationSec: 58.545 (skew: -1.455 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 23 — loadtest_fan_23@loadtest.local

- callId: `w18u9tQMYAPPIWmIwbVQcKVnGv32_6a0b5d74e33290ae92689d6f_1779129796398`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.398Z
- billingRestStartedAt: 2026-05-18T18:43:17.695Z
- billingStartedEventAt: 2026-05-18T18:43:17.462Z
- lastBillingUpdateAt: 2026-05-18T18:44:16.439Z
- forceEndAt: 2026-05-18T18:44:16.441Z
- durationSec: 58.746 (skew: -1.254 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 24 — loadtest_fan_24@loadtest.local

- callId: `zxaCqW6br2hjryezkHQcZomjMYp1_6a0b5d77e33290ae92689d78_1779129796591`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.591Z
- billingRestStartedAt: 2026-05-18T18:43:18.776Z
- billingStartedEventAt: 2026-05-18T18:43:18.522Z
- lastBillingUpdateAt: 2026-05-18T18:44:17.337Z
- forceEndAt: 2026-05-18T18:44:17.338Z
- durationSec: 58.562 (skew: -1.438 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 25 — loadtest_fan_25@loadtest.local

- callId: `8cjtDf0FeMYwdfdIzCXdFrpbrPy2_6a0b5d79e33290ae92689d81_1779129796497`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.497Z
- billingRestStartedAt: 2026-05-18T18:43:17.912Z
- billingStartedEventAt: 2026-05-18T18:43:17.676Z
- lastBillingUpdateAt: 2026-05-18T18:44:16.431Z
- forceEndAt: 2026-05-18T18:44:16.432Z
- durationSec: 58.520 (skew: -1.480 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 26 — loadtest_fan_26@loadtest.local

- callId: `89sBrbXkyBO90W7N7xsGWMKlaH63_6a0b5d7ce33290ae92689d8a_1779129796372`
- workerStartedAt: 2026-05-18T18:43:15.249Z
- socketConnectedAt: 2026-05-18T18:43:16.372Z
- billingRestStartedAt: 2026-05-18T18:43:17.742Z
- billingStartedEventAt: 2026-05-18T18:43:17.504Z
- lastBillingUpdateAt: 2026-05-18T18:44:16.431Z
- forceEndAt: 2026-05-18T18:44:16.431Z
- durationSec: 58.689 (skew: -1.311 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 27 — loadtest_fan_27@loadtest.local

- callId: `gJHbxzuhnWdhBg8Qj9YsyUwdJvo2_6a0b5d7ee33290ae92689d93_1779129796512`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.512Z
- billingRestStartedAt: 2026-05-18T18:43:18.747Z
- billingStartedEventAt: 2026-05-18T18:43:18.470Z
- lastBillingUpdateAt: 2026-05-18T18:44:17.324Z
- forceEndAt: 2026-05-18T18:44:17.325Z
- durationSec: 58.578 (skew: -1.422 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 28 — loadtest_fan_28@loadtest.local

- callId: `tiCvi7DlJ4T7UEeYeS7GTbCCi8a2_6a0b5d81e33290ae92689d9c_1779129796502`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.502Z
- billingRestStartedAt: 2026-05-18T18:43:17.914Z
- billingStartedEventAt: 2026-05-18T18:43:17.679Z
- lastBillingUpdateAt: 2026-05-18T18:44:16.439Z
- forceEndAt: 2026-05-18T18:44:16.441Z
- durationSec: 58.527 (skew: -1.473 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 29 — loadtest_fan_29@loadtest.local

- callId: `O3SsM0NPfGaTarBGsnUlJVTL1ox2_6a0b5d83e33290ae92689da5_1779129796425`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.425Z
- billingRestStartedAt: 2026-05-18T18:43:17.870Z
- billingStartedEventAt: 2026-05-18T18:43:17.641Z
- lastBillingUpdateAt: 2026-05-18T18:44:16.434Z
- forceEndAt: 2026-05-18T18:44:16.436Z
- durationSec: 58.566 (skew: -1.434 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 30 — loadtest_fan_30@loadtest.local

- callId: `XoG6GDAawUMRDfWXj5snRZ5qmXC3_6a0b5d86e33290ae92689dae_1779129796666`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.666Z
- billingRestStartedAt: 2026-05-18T18:43:18.775Z
- billingStartedEventAt: 2026-05-18T18:43:18.526Z
- lastBillingUpdateAt: 2026-05-18T18:44:17.323Z
- forceEndAt: 2026-05-18T18:44:17.323Z
- durationSec: 58.548 (skew: -1.452 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 31 — loadtest_fan_31@loadtest.local

- callId: `aWLulZuwcyafG2KbXZD0i0B0Uxz2_6a0b5d88e33290ae92689db7_1779129796422`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.422Z
- billingRestStartedAt: 2026-05-18T18:43:18.819Z
- billingStartedEventAt: 2026-05-18T18:43:18.589Z
- lastBillingUpdateAt: 2026-05-18T18:44:17.323Z
- forceEndAt: 2026-05-18T18:44:17.323Z
- durationSec: 58.504 (skew: -1.496 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 32 — loadtest_fan_32@loadtest.local

- callId: `FM4eC1ZDeTgLWbDmwAm3Wd0c1X13_6a0b5d8ae33290ae92689dc0_1779129796667`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.667Z
- billingRestStartedAt: 2026-05-18T18:43:18.775Z
- billingStartedEventAt: 2026-05-18T18:43:18.527Z
- lastBillingUpdateAt: 2026-05-18T18:44:17.319Z
- forceEndAt: 2026-05-18T18:44:17.320Z
- durationSec: 58.545 (skew: -1.455 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 33 — loadtest_fan_33@loadtest.local

- callId: `6bIf0cI2ILTqDhhAaKMVr5DDOPq2_6a0b5d8de33290ae92689dc9_1779129796522`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.522Z
- billingRestStartedAt: 2026-05-18T18:43:18.771Z
- billingStartedEventAt: 2026-05-18T18:43:18.517Z
- lastBillingUpdateAt: 2026-05-18T18:44:17.313Z
- forceEndAt: 2026-05-18T18:44:17.314Z
- durationSec: 58.543 (skew: -1.457 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 34 — loadtest_fan_34@loadtest.local

- callId: `SBvq0tnV2PS7zu0Mg9HcYvjjcX33_6a0b5d8fe33290ae92689dd2_1779129796326`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.326Z
- billingRestStartedAt: 2026-05-18T18:43:17.175Z
- billingStartedEventAt: 2026-05-18T18:43:16.939Z
- lastBillingUpdateAt: 2026-05-18T18:44:15.955Z
- forceEndAt: 2026-05-18T18:44:15.957Z
- durationSec: 58.782 (skew: -1.218 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 35 — loadtest_fan_35@loadtest.local

- callId: `3JnSrMIRmqYklWNPa5fSDdrynao1_6a0b5d92e33290ae92689ddb_1779129796330`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.330Z
- billingRestStartedAt: 2026-05-18T18:43:17.176Z
- billingStartedEventAt: 2026-05-18T18:43:16.942Z
- lastBillingUpdateAt: 2026-05-18T18:44:15.955Z
- forceEndAt: 2026-05-18T18:44:15.957Z
- durationSec: 58.781 (skew: -1.219 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 36 — loadtest_fan_36@loadtest.local

- callId: `96rnCKKM1lOQlItuhGSd2IrJsk02_6a0b5d94e33290ae92689de4_1779129796384`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.384Z
- billingRestStartedAt: 2026-05-18T18:43:17.743Z
- billingStartedEventAt: 2026-05-18T18:43:17.505Z
- lastBillingUpdateAt: 2026-05-18T18:44:16.431Z
- forceEndAt: 2026-05-18T18:44:16.432Z
- durationSec: 58.689 (skew: -1.311 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 37 — loadtest_fan_37@loadtest.local

- callId: `2faZp9dEFXfDtj7qOhKSnZ1DaUt1_6a0b5d97e33290ae92689ded_1779129796550`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.550Z
- billingRestStartedAt: 2026-05-18T18:43:18.771Z
- billingStartedEventAt: 2026-05-18T18:43:18.516Z
- lastBillingUpdateAt: 2026-05-18T18:44:17.311Z
- forceEndAt: 2026-05-18T18:44:17.311Z
- durationSec: 58.540 (skew: -1.460 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 38 — loadtest_fan_38@loadtest.local

- callId: `9qWwHg4tTFdo6wfYKWDPVZixGjG3_6a0b5d99e33290ae92689df6_1779129796518`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.518Z
- billingRestStartedAt: 2026-05-18T18:43:18.774Z
- billingStartedEventAt: 2026-05-18T18:43:18.518Z
- lastBillingUpdateAt: 2026-05-18T18:44:17.318Z
- forceEndAt: 2026-05-18T18:44:17.320Z
- durationSec: 58.546 (skew: -1.454 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 39 — loadtest_fan_39@loadtest.local

- callId: `cFUDM6SWM9TyO9JGyhR96jy7sBW2_6a0b5d9ce33290ae92689dff_1779129796391`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.391Z
- billingRestStartedAt: 2026-05-18T18:43:18.775Z
- billingStartedEventAt: 2026-05-18T18:43:18.529Z
- lastBillingUpdateAt: 2026-05-18T18:44:17.324Z
- forceEndAt: 2026-05-18T18:44:17.324Z
- durationSec: 58.549 (skew: -1.451 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 40 — loadtest_fan_40@loadtest.local

- callId: `EgTCbThCzNcZjo2m1N9isuHdV1K2_6a0b5d9ee33290ae92689e08_1779129796396`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.396Z
- billingRestStartedAt: 2026-05-18T18:43:17.699Z
- billingStartedEventAt: 2026-05-18T18:43:17.466Z
- lastBillingUpdateAt: 2026-05-18T18:44:16.433Z
- forceEndAt: 2026-05-18T18:44:16.435Z
- durationSec: 58.736 (skew: -1.264 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 41 — loadtest_fan_41@loadtest.local

- callId: `Iz93mGYFD4POdThlcMMlxVkFoKX2_6a0b5da0e33290ae92689e11_1779129796515`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.515Z
- billingRestStartedAt: 2026-05-18T18:43:18.747Z
- billingStartedEventAt: 2026-05-18T18:43:18.468Z
- lastBillingUpdateAt: 2026-05-18T18:44:17.319Z
- forceEndAt: 2026-05-18T18:44:17.321Z
- durationSec: 58.574 (skew: -1.426 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 42 — loadtest_fan_42@loadtest.local

- callId: `zzbooeNHXibtXfe5w3WRG7LFAI33_6a0b5da3e33290ae92689e1a_1779129796655`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.655Z
- billingRestStartedAt: 2026-05-18T18:43:18.774Z
- billingStartedEventAt: 2026-05-18T18:43:18.525Z
- lastBillingUpdateAt: 2026-05-18T18:44:17.337Z
- forceEndAt: 2026-05-18T18:44:17.338Z
- durationSec: 58.564 (skew: -1.436 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 43 — loadtest_fan_43@loadtest.local

- callId: `mXftzhb2ddNexd11MKZItLBvmRq1_6a0b5da5e33290ae92689e23_1779129796388`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.388Z
- billingRestStartedAt: 2026-05-18T18:43:18.777Z
- billingStartedEventAt: 2026-05-18T18:43:18.519Z
- lastBillingUpdateAt: 2026-05-18T18:44:17.324Z
- forceEndAt: 2026-05-18T18:44:17.325Z
- durationSec: 58.548 (skew: -1.452 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 44 — loadtest_fan_44@loadtest.local

- callId: `t9v6ulxBrjQuvaCxDtWYepsNGwJ3_6a0b5da8e33290ae92689e2c_1779129796418`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.418Z
- billingRestStartedAt: 2026-05-18T18:43:17.856Z
- billingStartedEventAt: 2026-05-18T18:43:17.621Z
- lastBillingUpdateAt: 2026-05-18T18:44:16.439Z
- forceEndAt: 2026-05-18T18:44:16.441Z
- durationSec: 58.585 (skew: -1.415 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 45 — loadtest_fan_45@loadtest.local

- callId: `ZhtksudzzFPmfYtZJISWnHQTVI02_6a0b5daae33290ae92689e35_1779129796378`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.378Z
- billingRestStartedAt: 2026-05-18T18:43:17.182Z
- billingStartedEventAt: 2026-05-18T18:43:16.949Z
- lastBillingUpdateAt: 2026-05-18T18:44:15.957Z
- forceEndAt: 2026-05-18T18:44:15.960Z
- durationSec: 58.778 (skew: -1.222 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 46 — loadtest_fan_46@loadtest.local

- callId: `EQ7LDb86hWdbEXVTHCEYTcuFAqG2_6a0b5dade33290ae92689e3e_1779129796584`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.584Z
- billingRestStartedAt: 2026-05-18T18:43:18.775Z
- billingStartedEventAt: 2026-05-18T18:43:18.520Z
- lastBillingUpdateAt: 2026-05-18T18:44:17.319Z
- forceEndAt: 2026-05-18T18:44:17.320Z
- durationSec: 58.545 (skew: -1.455 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 47 — loadtest_fan_47@loadtest.local

- callId: `zFOV5oe1IvTdaYtHaDlY9SVlxOB3_6a0b5dafe33290ae92689e47_1779129796394`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.394Z
- billingRestStartedAt: 2026-05-18T18:43:17.744Z
- billingStartedEventAt: 2026-05-18T18:43:17.506Z
- lastBillingUpdateAt: 2026-05-18T18:44:16.439Z
- forceEndAt: 2026-05-18T18:44:16.442Z
- durationSec: 58.698 (skew: -1.302 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 48 — loadtest_fan_48@loadtest.local

- callId: `7RwqRdgq5icHKuXzTIAzImOE0ld2_6a0b5db1e33290ae92689e50_1779129796548`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.548Z
- billingRestStartedAt: 2026-05-18T18:43:18.747Z
- billingStartedEventAt: 2026-05-18T18:43:18.471Z
- lastBillingUpdateAt: 2026-05-18T18:44:17.314Z
- forceEndAt: 2026-05-18T18:44:17.318Z
- durationSec: 58.571 (skew: -1.429 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 49 — loadtest_fan_49@loadtest.local

- callId: `Xzsl1tEDfeUOOm0ni0E4bJdMze82_6a0b5db4e33290ae92689e59_1779129796489`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.489Z
- billingRestStartedAt: 2026-05-18T18:43:17.911Z
- billingStartedEventAt: 2026-05-18T18:43:17.675Z
- lastBillingUpdateAt: 2026-05-18T18:44:16.437Z
- forceEndAt: 2026-05-18T18:44:16.442Z
- durationSec: 58.531 (skew: -1.469 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17

### User 50 — loadtest_fan_50@loadtest.local

- callId: `2jeRUCyOJyblaKYY02OWhy1cueB2_6a0b5db6e33290ae92689e62_1779129796370`
- workerStartedAt: 2026-05-18T18:43:15.250Z
- socketConnectedAt: 2026-05-18T18:43:16.370Z
- billingRestStartedAt: 2026-05-18T18:43:17.699Z
- billingStartedEventAt: 2026-05-18T18:43:17.467Z
- lastBillingUpdateAt: 2026-05-18T18:44:16.430Z
- forceEndAt: 2026-05-18T18:44:16.430Z
- durationSec: 58.731 (skew: -1.269 vs expected 60)
- forceEndReason: insufficient_coins
- remainingCoins: 0
- CallHistory.durationSeconds: 59
- CallHistory.coinsDeducted: 60
- CallHistory.coinsEarned: 17
