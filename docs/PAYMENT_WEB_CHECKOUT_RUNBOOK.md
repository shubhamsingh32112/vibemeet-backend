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

## 3) Canonical URL configuration (prevents wrong apiBase)

Set these in production:
- `PUBLIC_API_BASE_URL=https://YOUR_API_DOMAIN/api/v1`
- `WEB_CHECKOUT_BASE_URL=https://www.mannatenterprises.shop`

If `PUBLIC_API_BASE_URL` is missing, the backend may embed an incorrect `apiBase` in checkout URLs, leading to CORS failures.

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

