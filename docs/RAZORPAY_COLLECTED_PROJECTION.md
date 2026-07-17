# Razorpay Collected Amount projection

Command Center uses live Razorpay provider scans for bounded date ranges. `All time` reads the
`razorpay_captured_payments` Mongo projection and exposes backfill completeness metadata.

## Initial backfill

Deploy the model and observation writers first, then run once with the same Razorpay mode and
credentials as the API:

```powershell
npm run backfill:razorpay-captured
```

The job freezes an `asOf`, paginates Razorpay with `count=100`, and checkpoints `nextSkip` after
each fully persisted page. Re-running resumes the same frozen scan. Upserts are keyed by Razorpay
payment ID, so replaying a page is safe. A Mongo lease prevents concurrent runners.

The API reports `completeness.complete=false` until the marker reaches `complete`. Do not compare
or advertise the All-time number as authoritative before then. Current verified wallet, VIP, and
Moments purchases continue to upsert the projection while backfill runs.

If the job fails, correct the credential/network/provider problem and run it again. Do not delete
the checkpoint unless intentionally restarting the entire historical scan. Test and live modes
have separate checkpoint markers and projection queries.

## Reconciliation

After completion, compare the All-time currency buckets and several bounded IST windows with the
Razorpay Dashboard. Bounded windows intentionally remain provider-backed until timestamp semantics
and delayed-capture parity are proven.
