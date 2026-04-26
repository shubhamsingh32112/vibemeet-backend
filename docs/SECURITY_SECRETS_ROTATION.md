# Secrets Rotation Checklist (Required)

The repository previously contained real credentials in `backend/.env`. Treat all of them as **compromised**.

## 1) Rotate provider secrets (immediately)
- **Firebase service account**: create a new key, disable/delete the old key.
- **JWT / checkout session secrets**: rotate `JWT_SECRET` and `CHECKOUT_SESSION_SECRET`.
- **Razorpay**: rotate `RAZORPAY_KEY_SECRET` (and `KEY_ID` if needed).
- **Redis**: rotate password / regenerate connection strings.
- **MongoDB**: rotate DB user password (or create a new least-privilege user).
- **Stream (Chat/Video)**: rotate `STREAM_API_SECRET` / `STREAM_VIDEO_API_SECRET`.

## 2) Move secrets to your deployment secret store
- Railway/Render/Fly/Vercel/etc: set these values in the platform UI as **Secrets/Environment Variables**.
- Do not store secrets in the repo. Use `backend/.env.example` as a template only.

## 3) Re-deploy and verify
- Re-deploy backend with new secrets.
- Verify:
  - `GET /health` returns 200
  - Web checkout preflight returns `Access-Control-Allow-Origin`
  - `POST /api/v1/payment/web/create-order` succeeds with valid session
  - Razorpay webhook signature verification works with the new webhook secret

## 4) Audit for leaked usage
- Check provider dashboards/logs for suspicious access using the old credentials.
- If any tokens were minted (JWTs), consider invalidation (short TTLs, rotate signing key).

