# Payment Web Checkout Runbook (Ops)

## Scope
Applies to the web checkout flow:
- App calls `POST /api/v1/payment/web/initiate` (auth required) to get a checkout URL.
- Browser opens `/wallet-checkout?...` which calls:
  - `POST /api/v1/payment/web/create-order`
  - Razorpay checkout
  - `POST /api/v1/payment/web/verify`
- Razorpay webhooks call `POST /api/v1/payment/webhook`.

## 1) Quick health checks

### Backend liveness
- `GET /health` should return JSON `{ status: "ok" }` (root path, not under `/api/v1`).

### Checkout endpoints
- `OPTIONS /api/v1/payment/web/create-order` must return **2xx** with CORS headers (see below).
- `POST /api/v1/payment/web/create-order` must return `{ success: true, data: { orderId, keyId, ... } }` for valid sessions.

## 2) CORS checklist (most common prod failure)

### Symptoms
Browser shows:
- `blocked by CORS policy`
- `No 'Access-Control-Allow-Origin' header`
- UI message: “Could not reach payment server…”

### What must be true
For origin `https://www.mannatenterprises.shop` calling your API domain:
- Preflight `OPTIONS` response includes:
  - `Access-Control-Allow-Origin: https://www.mannatenterprises.shop` (or exact origin reflected)
  - `Access-Control-Allow-Methods` includes `POST, OPTIONS`
  - `Access-Control-Allow-Headers` includes `content-type`

### Configuration
Set `CORS_ORIGIN` on the backend to a comma-separated allowlist, e.g.:
- `CORS_ORIGIN=https://www.mannatenterprises.shop,https://mannatenterprises.lovable.app`

Wildcard patterns are supported (example):
- `CORS_ORIGIN=https://*.mannatenterprises.shop`

### Verification command (preflight)
Run from any machine:

```bash
curl -i -X OPTIONS 'https://YOUR_API_DOMAIN/api/v1/payment/web/create-order' \
  -H 'Origin: https://www.mannatenterprises.shop' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type'
```

## 3) Canonical URL configuration

Set these in production:
- `WEB_CHECKOUT_BASE_URL=https://www.mannatenterprises.shop`
- `WEB_APP_BASE_URL=https://www.flirtycam.in`
- Hosted checkout: `VITE_API_BASE_URL=https://YOUR_API_DOMAIN/api/v1`

Checkout URLs never accept or embed an `apiBase` query parameter. The hosted build is the
only API-origin authority. Web initiators send `checkoutOrigin=web` and a bounded relative
`returnTo`; the backend signs those claims and returns allowlisted `returnTarget` values.
Legacy initiators that omit the fields continue to receive app deep links.

Website returns use opaque `checkoutId` values at `/payment/return`. The authenticated
`GET /api/v1/payment/web/status/:checkoutId` response is authoritative; query-string status
and reason values are display hints only.

## 4) Metrics to monitor (backend `/metrics`)

### Web create-order
- `payment.web.create_order_success`
- `payment.web.create_order_failed` (tagged by `reason`)
- `payment.web.create_order_duration_ms`

### Web verify
- `payment.web.verify_success`
- `payment.web.verify_failed` (tagged by `reason`)
- `payment.web.verify_duration_ms`

### Webhook processing + retries
- `payment.webhook.received`
- `payment.webhook.processed`
- `payment.webhook.process_failed`
- `payment.webhook.retry_*`

## 5) Alert suggestions (starting points)
- Spike in `payment.web.create_order_failed` or `payment.web.verify_failed`
- Non-zero growth in `payment.webhook.process_failed`
- Request queue timeouts `api.request_queue_timeout` > 0
- Elevated `api.http_5xx`

## 6) UPI missing in Razorpay checkout (troubleshooting)

### Razorpay Dashboard (merchant)
- Confirm **UPI** (and UPI Intent if you use it) is enabled for the account and not blocked by risk rules.
- Domestic **INR** settlement and appropriate **MCC** affect which instruments appear.

### User environment
- **Web checkout** opens in the device browser (`externalApplication`). **iOS Safari** historically shows fewer UPI entry paths than **Android Chrome**; test both.
- VPN, non-India IP, corporate DNS, ad blockers, or strict private mode can hide instruments or block `checkout.razorpay.com`.

### Website (`WalletCheckout.tsx`)
- Checkout uses Razorpay **Standard Checkout** with **default instruments only** (no custom `display.blocks`), so every user sees the same Razorpay UI and UPI appears whenever Razorpay + the merchant account expose it for that device.
- If many users still lack UPI, inspect Razorpay **failed payments** and the `payment.failed` payload in browser devtools for that session.

### Backend
- `POST /payment/web/create-order` does not restrict payment methods on the Razorpay **order** object; instrument availability is decided by Razorpay + dashboard settings + client environment.

