# Eazy Talks Backend

Node.js/TypeScript backend API for Eazy Talks mobile app.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file in the root directory with:
```
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_jwt_secret
FIREBASE_PROJECT_ID=your_firebase_project_id
FIREBASE_PRIVATE_KEY=your_firebase_private_key
FIREBASE_CLIENT_EMAIL=your_firebase_client_email
PORT=3000
CORS_ORIGIN=*
```

3. Run in development:
```bash
npm run dev
```

4. Build for production:
```bash
npm run build
npm start
```

## API Endpoints

### Authentication
- `POST /api/v1/auth/login` - Login with Firebase token
- `POST /api/v1/auth/logout` - Logout

### User
- `GET /api/v1/user/me` - Get current user profile

All authenticated endpoints require `Authorization: Bearer <firebase_id_token>` header.

### Ops / monitoring

- `GET /metrics` — process-local stats: Mongo pool utilization, Redis driver error/close counts, API latency samples (from in-memory ring), request queue depth.
- `GET /ready` — Mongo + Redis read/write checks for orchestrator readiness.

## Scaling and video billing (multi-instance)

Optional environment variables:

| Variable | Purpose |
|----------|---------|
| `MONGO_POOL_SIZE` / `MONGO_MIN_POOL_SIZE` | Per-process MongoDB pool (defaults **50** / **5**). Set so `(pool × Railway replicas) ≤ Atlas connection limit`; avoid very large pools. |
| `BILLING_DRIVER=bullmq` | Use BullMQ for per-call billing ticks instead of `setInterval` on each Node process (recommended with 2+ API replicas). Requires Redis. |
| `SOCKET_IO_REDIS_ADAPTER` | Defaults to enabled when Redis is configured. Set to `false` only for single-node debugging. |
| `REDIS_URL` / `REDISHOST` | Required for billing, Socket.IO adapter, and BullMQ. |
| `CORS_ORIGIN` | Comma-separated allowed origins for web clients. In production, prefer explicit origins instead of `*`. |

### BullMQ billing (`BILLING_DRIVER=bullmq`)

1. Set `BILLING_DRIVER=bullmq` in production when running **more than one** API replica so billing work is not duplicated per instance (the default ZSET + `setInterval` loop runs on every process).
2. Redis must be reachable; BullMQ uses a dedicated connection with `maxRetriesPerRequest: null` (see [billing.queue.ts](src/modules/billing/billing.queue.ts)).
3. On startup, the app starts a **Worker** in the same process that processes delayed `billing-cycle` jobs; `scheduleBillingJob` is invoked when a billing session starts (instead of registering in `ACTIVE_BILLING_CALLS_KEY` for the timer path).
4. Socket.IO broadcasts (`billing:update`, etc.) still use `getIO()` from the worker process — all replicas should share the same Redis adapter so emits reach clients on any node.
5. To disable the timer-based processor, `startGlobalBillingProcessor` no-ops when BullMQ is enabled (worker handles ticks).

See [src/modules/billing/billing.queue.ts](src/modules/billing/billing.queue.ts).

### Video webhook

`POST /api/v1/video/webhook` uses **raw body bytes** for HMAC verification (`STREAM_VIDEO_API_SECRET`). Ensure no proxy rewrites the JSON payload.
