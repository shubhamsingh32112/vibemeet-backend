# Reverse proxy and `/api/v1`

The Express app mounts all REST routes under **`/api/v1`** (see `server.ts`). Clients use a base URL ending in `/api/v1` and paths such as `/images/direct-upload`, `/creator/feed`, `/user/call-history`.

## Required paths

Proxies (nginx, Cloudflare, load balancers) must forward **the same path prefix** the app uses:

- `/api/v1/images/*` — Cloudflare Images direct upload and presets (not optional for uploads).
- `/api/v1/creator/*` — creator feed, profile, gallery commit.
- `/api/v1/user/*` — user APIs including call history.

If `/api/v1/user/...` works but uploads return **`{ "error": "Route not found" }`**, the edge is likely stripping or routing `/api/v1/images` elsewhere. Fix the proxy map so those requests hit the same Node process as other API routes.

## Health checks

- `GET /api/v1/images/health` — image pipeline feature flag (no auth).
- Authenticated: `GET /api/v1/images/presets`, `POST /api/v1/images/direct-upload`.
