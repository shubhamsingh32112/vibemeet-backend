# Phase 4 & 5 Implementation Changelog

Detailed record of code changes from the **Phase 4–5 Hardening** execution plan.  
Source plan: `phase_4-5_hardening_705b67a5.plan.md` (not modified by this work).

**Gating reminder**

| Category | Safe on staging/dev now | Production rollout gated |
|----------|-------------------------|--------------------------|
| PR1, PR3, PR4, PR5, PR6, 5A | Yes | N/A or doc-only |
| PR2 feed rank ZSET | Shadow/staging | Milestone B + canary |
| 5B concurrency default | Staging validation | Milestone B prod signoff |

---

## Files touched (summary)

| Area | New files | Modified files |
|------|-----------|----------------|
| PR1 Admin/moments | — | `admin-dashboard.service.ts`, `admin.controller.ts`, `moments.controller.ts`, `admin-dashboard.contract.test.ts`, `adminWebsite/src/services/adminService.ts` |
| PR2 Feed rank | `creator-feed-rank.service.ts`, `creator-feed-rank-flags.ts`, `creator-feed-rank-score.ts`, `creator-feed-rank.contract.test.ts` | `creator.controller.ts`, `redis.ts`, `presence.service.ts`, `bootstrap-api-ws.ts`, `creator-feed.contract.test.ts` |
| PR3 UIDs bound | `creator-uids-cache.service.ts` | `creator.controller.ts`, `user.controller.ts`, `redis.ts`, `creator-feed.contract.test.ts` |
| PR4 Index audit | `scripts/audit-mongo-indexes.ts`, `docs/INDEX_MIGRATION_PLAN.md` | `call-history.model.ts`, `creator-moment.model.ts`, `package.json` |
| PR5 Agg hardening | — | `admin.controller.ts`, `admin-dashboard.contract.test.ts` |
| PR6 Pool doc | `docs/CONNECTION_POOL_SIZING.md` | — |
| 5A Metrics | `scripts/billing-load-model.ts`, `bootstrap-ecs-metadata.ts`, `bootstrap-ecs-metadata.contract.test.ts` | `metrics-handler.ts`, `load-env.ts`, `docs/CANARY_MONITORING_RUNBOOK.md`, `package.json`, `.env.example` |
| 5B Concurrency | `docs/BILLING_CAPACITY_TUNING.md` | `billing.queue.ts`, `billing.queue.contract.test.ts`, `.env.example` |

---

## Phase 4 — PR1: Bound admin and moments queries

### 4.1.1 `dashboardTopHosts` — inverted query

**File:** `backend/src/modules/admin/admin-dashboard.service.ts`

**Before** — loaded entire creator catalog, sorted in Node, sliced top N:

```typescript
export async function dashboardTopHosts(limit: number, range?: DashboardDateFilter) {
  const lim = clampDashboardLimit(limit, 10);
  const creators = await Creator.find({}).select('name earningsCoins userId avatar').lean();
  // ... sorted all creators in memory by earnings ...
  return { rows: ranked.slice(0, lim).map(...) };
}
```

**After** — aggregate `CallHistory` first, fetch only top-N display rows:

```typescript
export async function dashboardTopHosts(limit: number, range?: DashboardDateFilter) {
  const lim = clampDashboardLimit(limit, 10);
  const { creatorStatsByUserId } = await aggregateCreatorPerformanceInRange(range);

  const rankedStats = [...creatorStatsByUserId.entries()]
    .map(([ownerUserId, stat]) => ({
      ownerUserId,
      calls: stat.calls,
      minutes: stat.minutes,
      earningsCoins: stat.earnings,
    }))
    .sort((a, b) => b.earningsCoins - a.earningsCoins || b.calls - a.calls)
    .slice(0, lim);

  const topUserIds = rankedStats
    .map((r) => r.ownerUserId)
    .filter((id) => id.length > 0)
    .map((id) => new mongoose.Types.ObjectId(id));

  const creatorRows =
    topUserIds.length > 0
      ? await Creator.find({ userId: { $in: topUserIds } })
          .select('name earningsCoins userId avatar')
          .lean()
      : [];
  // ... join stats to creator display fields ...
}
```

**Semantics preserved:** ranking by creator-side earnings (all-time or date-filtered range), same sort key (`earningsCoins` desc, then `calls`).

---

### 4.1.2 `computeCreatorsPerformance` — inverted query + pagination

**File:** `backend/src/modules/admin/admin.controller.ts`

**Before** — full catalog load, single cached payload:

```typescript
export const getCreatorsPerformance = async (req: Request, res: Response) => {
  const data = await getCachedOrCompute('creators_performance', computeCreatorsPerformance);
  res.json({ success: true, data });
};

async function computeCreatorsPerformance() {
  const creators = await Creator.find({}).lean();
  const users = await User.find({ _id: { $in: creators.map(c => c.userId) } }).lean();
  // ... build full table for every creator ...
  return { creators: performance };
}
```

**After** — aggregate-first, bounded creator set, server-side pagination:

```typescript
function parseCreatorsPerformancePaging(req: Request): { page: number; limit: number } {
  const rawPage = parseInt(String(req.query.page ?? '1'), 10);
  const rawLimit = parseInt(String(req.query.limit ?? '100'), 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 100;
  return { page, limit };
}

export const getCreatorsPerformance = async (req: Request, res: Response) => {
  const { page, limit } = parseCreatorsPerformancePaging(req);
  const cacheSection = `creators_performance:p${page}:l${limit}`;
  const data = await getCachedOrCompute(cacheSection, () =>
    computeCreatorsPerformance({ page, limit })
  );
  res.json({ success: true, data });
};

async function computeCreatorsPerformance(options: { page: number; limit: number }) {
  const idleDays = parseInt(process.env.ADMIN_PERFORMANCE_INCLUDE_IDLE_DAYS || '90', 10);
  const idleCutoff = daysAgo(Number.isFinite(idleDays) && idleDays > 0 ? idleDays : 90);

  // 1) Global CallHistory aggregations (all-time, 30d, period, abuse)
  const callStatsPerCreator = await CallHistory.aggregate([...]);

  // 2) Bounded creator IDs = call activity + recently created idle creators
  const activeUserIdSet = new Set<string>();
  for (const row of callStatsPerCreator) activeUserIdSet.add(row._id.toString());
  // ... also 30d + abuse agg rows ...
  const idleCreators = await Creator.find({ createdAt: { $gte: idleCutoff } })
    .select('userId')
    .lean();

  const boundedUserIds = [...activeUserIdSet].map((id) => new mongoose.Types.ObjectId(id));
  const creators =
    boundedUserIds.length > 0
      ? await Creator.find({ userId: { $in: boundedUserIds } }).lean()
      : [];

  // 3) Paginate sorted performance table
  performance.sort((a, b) => b.earned30d - a.earned30d);
  const total = performance.length;
  const skip = (page - 1) * limit;
  const paginated = performance.slice(skip, skip + limit);

  return {
    creators: paginated,
    total,
    page,
    limit,
    note: `Creators with call activity or created within the last ${idleDays} days...`,
  };
}
```

**Admin website client** (`adminWebsite/src/services/adminService.ts`) — paginates through all pages so existing UI still receives a full list:

```typescript
getCreatorsPerformance: async (): Promise<CreatorPerformance[]> => {
  const limit = 100;
  let page = 1;
  let total = Infinity;
  const all: CreatorPerformance[] = [];
  while (all.length < total) {
    const res = await api.get('/admin/creators/performance', { params: { page, limit } });
    const data = res.data.data;
    all.push(...(data.creators ?? []));
    total = typeof data.total === 'number' ? data.total : all.length;
    if (!data.creators?.length || data.creators.length < limit) break;
    page += 1;
  }
  return all;
},
```

---

### 4.1.3 Moments analytics — bounded aggregation

**File:** `backend/src/modules/moments/controllers/moments.controller.ts`

**Before** — unbounded `find` to sum views:

```typescript
const moments = await CreatorMoment.find({ creatorId: creator._id });
const totalViews = moments.reduce((sum, m) => sum + (m.viewsCount ?? 0), 0);
const postCount = moments.filter((m) => !m.isDeleted).length;
```

**After** — `$group` sum + `countDocuments`:

```typescript
const [viewsAgg] = await CreatorMoment.aggregate([
  { $match: { creatorId: creator._id } },
  { $group: { _id: null, totalViews: { $sum: '$viewsCount' } } },
]);
const postCount = await CreatorMoment.countDocuments({
  creatorId: creator._id,
  isDeleted: false,
});
res.json({
  success: true,
  data: {
    momentsEarnings: agg?.totalEarnings ?? 0,
    purchaseCount: agg?.purchaseCount ?? 0,
    totalViews: viewsAgg?.totalViews ?? 0,
    postCount,
  },
});
```

---

## Phase 4 — PR2: Feed availability rank ZSET (flag-gated)

### New module: score encoding

**File:** `backend/src/modules/creator/creator-feed-rank-score.ts`

```typescript
export type CreatorPresenceRankState = 'online' | 'on_call' | 'offline';

export function encodeFeedRankScore(
  state: CreatorPresenceRankState | undefined,
  createdAtMs: number
): number {
  const tier = state === 'online' ? 0 : state === 'on_call' ? 1 : 2;
  const tieBreak = Math.max(0, MAX_TS - Math.max(0, createdAtMs));
  return tier * 1e13 + tieBreak;
}
```

Ordering: `online` < `on_call` < `offline`; within tier, newer `createdAt` ranks higher.

### New module: rank service

**File:** `backend/src/modules/creator/creator-feed-rank.service.ts`

Key behaviors:

- Redis key: `creator:feed:rank:v1` (ZSET, member = `creatorId`)
- **Rebuild:** cursor-batched (`REBUILD_BATCH = 500`), startup/operator only
- **Read path:** `getAvailabilityFeedPageFromRank(skip, limit)` → `ZRANGE`
- **Presence hook:** `updateCreatorFeedRankOnPresence` (best-effort `ZADD`)
- **Delete cleanup:** `removeCreatorFromFeedRank`
- **Shadow:** `recordFeedRankShadowMismatchIfNeeded` compares rank vs legacy page IDs

### Redis keys

**File:** `backend/src/config/redis.ts`

```typescript
export const CREATOR_FEED_RANK_KEY = 'creator:feed:rank:v1';

// Feed cache invalidation now also clears rank index:
await redis.del(...keys, CREATOR_FEED_INDEX_KEY, CREATOR_FEED_RANK_KEY);
```

### Feed controller — availability sort

**File:** `backend/src/modules/creator/creator.controller.ts`

**Before** — always in-memory full-catalog sort:

```typescript
if (feedSort === 'availability') {
  const minimal = await Creator.find({}).select('_id userId firebaseUid createdAt').lean();
  total = minimal.length;
  // ... presence batch + sort entire catalog in Node ...
  pageIds = rankRows.slice(skip, skip + limit).map((r) => r.id);
}
```

**After** — try ZSET first; legacy fallback; optional shadow compare:

```typescript
if (feedSort === 'availability') {
  const rankPage = await getAvailabilityFeedPageFromRank(skip, limit);

  const buildLegacyAvailabilityPage = async (): Promise<mongoose.Types.ObjectId[]> => {
    const minimal = await Creator.find({})
      .select('_id userId firebaseUid createdAt')
      .lean();
    // ... existing in-memory sort (fallback authority: Mongo + presence) ...
    return rankRows.slice(skip, skip + limit).map((r) => r.id);
  };

  if (rankPage && rankPage.pageIds.length > 0) {
    total = rankPage.total;
    pageIds = rankPage.pageIds;
    if (process.env.CREATOR_FEED_RANK_SHADOW === 'true') {
      const legacyIds = await buildLegacyAvailabilityPage();
      await recordFeedRankShadowMismatchIfNeeded(
        legacyIds.map((id) => id.toString()),
        pageIds.map((id) => id.toString()),
      );
    }
  } else {
    pageIds = await buildLegacyAvailabilityPage();
  }

  const creators = pageIds.length > 0
    ? await Creator.find({ _id: { $in: pageIds } }).select(feedSelect).lean()
    : [];
}
```

### Presence coupling (cache invalidation only — no authority transfer)

**File:** `backend/src/modules/availability/presence.service.ts`

```typescript
if (statusChanged) {
  import('../creator/creator-feed-rank.service')
    .then(async ({ updateCreatorFeedRankOnPresence }) => {
      const { Creator } = await import('../creator/creator.model');
      const row = await Creator.findOne({ firebaseUid }).select('_id createdAt').lean();
      if (!row?._id) return;
      await updateCreatorFeedRankOnPresence(
        row._id.toString(),
        firebaseUid,
        nextRecord.state,
        row.createdAt?.getTime() ?? Date.now(),
      );
    })
    .catch(() => {});
}
```

### Startup rebuild

**File:** `backend/src/bootstrap/bootstrap-api-ws.ts`

```typescript
if (shouldRebuildCreatorFeedRankOnStartup()) {
  rebuildCreatorFeedRankIndex().catch((err) => {
    logError('Creator feed rank startup rebuild failed', err);
  });
}
```

### Env flags

```bash
CREATOR_FEED_REDIS_RANK_ENABLED=false   # default off — legacy path
CREATOR_FEED_RANK_SHADOW=false          # telemetry only
CREATOR_FEED_RANK_REBUILD=false         # startup rebuild
CREATOR_FEED_AVAILABILITY_MAX_CATALOG=8000
```

---

## Phase 4 — PR3: Bound `/creator/uids`

### New cache service

**File:** `backend/src/modules/creator/creator-uids-cache.service.ts`

Layers:

1. JSON snapshot: `creator:uids:v1` (60s TTL)
2. Redis SET: `creator:uids:set:v1`
3. Rebuild lock: `creator:uids:rebuild:lock` (prevents rebuild storms)
4. Miss path: Mongo **cursor** stream (`CURSOR_BATCH = 500`), not `find().lean()` on full array

```typescript
export async function getCreatorFirebaseUidsCached(): Promise<{
  firebaseUids: string[];
  cacheHit: boolean;
}> {
  // 1) JSON cache hit
  // 2) SET members hit → hydrate JSON
  // 3) acquire rebuild lock OR wait for peer rebuild
  // 4) streamCreatorFirebaseUidsFromMongo() + writeUidCaches()
}

export async function addCreatorFirebaseUidToCache(firebaseUid: string): Promise<void> {
  await redis.sadd(CREATOR_UIDS_SET_KEY, trimmed);
  await redis.del(CREATOR_UIDS_CACHE_KEY);
}

export async function removeCreatorFirebaseUidFromCache(firebaseUid: string): Promise<void> {
  await redis.srem(CREATOR_UIDS_SET_KEY, trimmed);
  await redis.del(CREATOR_UIDS_CACHE_KEY);
}
```

### Controller endpoint

**File:** `backend/src/modules/creator/creator.controller.ts`

**Before:**

```typescript
export const getCreatorFirebaseUids = async (req, res) => {
  const cached = await safeRedisGet(CREATOR_UIDS_CACHE_KEY);
  if (cached) return res.json({ data: { firebaseUids: cached.firebaseUids } });

  const creators = await Creator.find({}).select('firebaseUid userId').lean();
  const firebaseUids = creators.map(...); // full catalog materialized
  await safeRedisSet(CREATOR_UIDS_CACHE_KEY, JSON.stringify({ firebaseUids }), { ex: 60 });
  res.json({ data: { firebaseUids } });
};
```

**After:**

```typescript
export const getCreatorFirebaseUids = async (req, res) => {
  const { firebaseUids, cacheHit } = await getCreatorFirebaseUidsCached();
  logInfo('creator.uids.timing', { cacheHit, totalMs: Date.now() - t0, count: firebaseUids.length });
  res.json({ success: true, data: { firebaseUids } });
};
```

### Incremental membership on catalog changes

**Create** (`creator.controller.ts`):

```typescript
invalidateCreatorCatalogCaches().catch(() => {});
const createdUid = creator.firebaseUid?.trim() || targetUser.firebaseUid?.trim() || '';
if (createdUid) addCreatorFirebaseUidToCache(createdUid).catch(() => {});
```

**Delete** (`creator.controller.ts`):

```typescript
const deletedFirebaseUid = creator.firebaseUid?.trim() ? String(creator.firebaseUid).trim() : '';
// ... after transaction commit ...
if (deletedFirebaseUid) removeCreatorFirebaseUidFromCache(deletedFirebaseUid).catch(() => {});
removeCreatorFromFeedRank(id).catch(() => {});
```

**User promotion** (`user.controller.ts`):

```typescript
invalidateCreatorCatalogCaches().catch(() => {});
const promotedUid = createdCreator.firebaseUid?.trim() || targetUser.firebaseUid?.trim() || '';
if (promotedUid) addCreatorFirebaseUidToCache(promotedUid).catch(() => {});
```

---

## Phase 4 — PR4: Index audit script

### New script

**File:** `backend/scripts/audit-mongo-indexes.ts`

- Connects read-only via `MONGO_URI`
- Diffs schema-declared indexes vs Atlas `listIndexes()`
- Runs `explain('executionStats')` on canonical hot queries
- Classifies PASS/FAIL (`COLLSCAN`, `docsExamined > 10× nReturned`)
- Writes `backend/docs/INDEX_MIGRATION_PLAN.md`

**package.json:**

```json
"audit:mongo-indexes": "tsx scripts/audit-mongo-indexes.ts"
```

### Schema index additions

**`call-history.model.ts`:**

```typescript
callHistorySchema.index({ ownerRole: 1, ownerUserId: 1, createdAt: -1 });
```

**`creator-moment.model.ts`:**

```typescript
creatorMomentSchema.index({ creatorId: 1, isDeleted: 1 });
```

**`creator.model.ts`:** `firebaseUid` already has `index: true` + `sparse: true` on the field — no duplicate `schema.index()` added.

---

## Phase 4 — PR5: Aggregation hardening

**File:** `backend/src/modules/admin/admin.controller.ts` — refund signal path inside `computeCreatorsPerformance`

**Before** — unbounded `CallHistory.find` + single giant `$in`:

```typescript
const creatorCallIds = await CallHistory.find({
  ownerRole: 'creator',
  createdAt: { $gte: thirtyDaysAgo },
})
  .select('callId ownerUserId')
  .lean();

const allCallIds = creatorCallIds.map((r) => r.callId);
const refundsAgg = allCallIds.length > 0
  ? await CoinTransaction.aggregate([
      { $match: { callId: { $in: allCallIds }, source: 'admin', description: { $regex: /^REFUND/ } } },
      { $group: { _id: '$callId', count: { $sum: 1 } } },
    ])
  : [];
```

**After** — early `$match` + `$project` + `$addToSet`; batched refund lookup (500):

```typescript
const REFUND_LOOKUP_BATCH = 500;
const callIdsByCreatorAgg = await CallHistory.aggregate([
  {
    $match: {
      ownerRole: 'creator',
      createdAt: { $gte: thirtyDaysAgo },
    },
  },
  { $project: { ownerUserId: 1, callId: 1 } },
  {
    $group: {
      _id: '$ownerUserId',
      callIds: { $addToSet: '$callId' },
    },
  },
]);

const uniqueCallIds = [
  ...new Set(callIdsByCreatorAgg.flatMap((row) => row.callIds ?? [])),
];

const refundedCallIds = new Set<string>();
for (let offset = 0; offset < uniqueCallIds.length; offset += REFUND_LOOKUP_BATCH) {
  const batch = uniqueCallIds.slice(offset, offset + REFUND_LOOKUP_BATCH);
  const refundRows = await CoinTransaction.find({
    callId: { $in: batch },
    source: 'admin',
    description: { $regex: /^REFUND/ },
  })
    .select('callId')
    .lean();
  for (const row of refundRows) {
    if (row.callId) refundedCallIds.add(row.callId);
  }
}
```

---

## Phase 4 — PR6: Connection pool sizing

**New doc:** `backend/docs/CONNECTION_POOL_SIZING.md`

Documents target topology (4 api-ws + 2 billing + 1 moments + 1 image ≈ **230** total Mongo connections on M30).

---

## Phase 5A — Extended `/metrics`

**File:** `backend/src/bootstrap/metrics-handler.ts`

**Before** — billing section lacked queue depth, DLQ, locks, instance ID:

```typescript
billing: {
  backpressure: { currentStage: ... },
  tickDriftMs: { ... },
  bullmq: {
    queueLagAvgMs: ...,
    queueLagSamples: ...,
    rolling5m: { ... },
  },
  // no dlq, locks, instanceId, runtime.eventLoopLagP95
}
```

**After:**

```typescript
billing: {
  // ... existing fields ...
  instanceId: getBillingInstanceId(),
  dlq: {
    size: dlqSize,
    batchFetchP95Ms: byName['billing.dlq_batch_fetch_ms']?.p95 ?? 0,
  },
  locks: {
    watchdogSkipped5m: rollingWatchdogLockSkipped5m,
    watchdogAcquired5m: rollingWatchdogLockAcquired5m,
    reconSkipped5m: rollingReconLockSkipped5m,
    cycleLockDeferred5m: rollingCycleLockDeferred5m,
  },
  runtime: {
    eventLoopLagP95: Math.round((eventLoopLag?.p95 ?? 0) * 100) / 100,
  },
  bullmq: {
    queueLagAvgMs: ...,
    jobsActive: bullmqQueueSnapshot?.active ?? ...,
    jobsWaiting: bullmqQueueSnapshot?.waiting ?? ...,
    jobsDelayed: bullmqQueueSnapshot?.delayed ?? ...,
    concurrency: bullmqQueueSnapshot?.concurrency ?? readBullmqConcurrency(),
    rolling5m: { ... },
  },
  settlementTotalMs: { p95Ms: ..., ... },
},
presence: {
  feedRankZcard: feedRankZcard,
  // ... existing presence metrics ...
}
```

**New alert keys** (also documented in `docs/CANARY_MONITORING_RUNBOOK.md`):

| Alert | Condition |
|-------|-----------|
| `billing_dlq_size_high` | `dlq.size` > 50 |
| `billing_watchdog_lock_contention_high` | skipped/acquired > 30% (5m) |
| `billing_queue_depth_high` | delayed > max(100, 2× active) |
| `billing_settlement_p95_high` | settlement p95 > 5000ms |

---

## Phase 5A — ECS instance ID resolution

**New file:** `backend/src/bootstrap/bootstrap-ecs-metadata.ts`

```typescript
export async function resolveBillingInstanceIdFromEcs(): Promise<void> {
  if (process.env.BILLING_INSTANCE_ID?.trim()) return;

  const metadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4?.trim();
  if (!metadataUri) return;

  const res = await fetch(`${metadataUri}/task`, { signal: AbortSignal.timeout(2000) });
  const body = await res.json() as { TaskARN?: string };
  const taskArn = body.TaskARN?.trim();
  if (!taskArn) return;

  process.env.BILLING_INSTANCE_ID = parseTaskIdFromArn(taskArn); // last segment of ARN
}
```

**File:** `backend/src/bootstrap/load-env.ts`

```typescript
import { resolveBillingInstanceIdFromEcs } from './bootstrap-ecs-metadata';
void resolveBillingInstanceIdFromEcs();
```

Fallback when not on ECS: existing `getBillingInstanceId()` hostname:pid behavior.

---

## Phase 5A — Billing load model script

**New file:** `backend/scripts/billing-load-model.ts`

```bash
npm run billing:load-model
```

Stability probe (not saturation):

- Samples active billing sessions from Redis
- Reports queue lag p50/p95, DLQ size, current concurrency
- Emits tuning **guidance** table (not max-capacity claims)

Env: `BILLING_LOAD_MODEL_CALLS=500` (default).

---

## Phase 5B — Concurrency default + tuning doc

**File:** `backend/src/modules/billing/billing.queue.ts`

**Before:**

```typescript
const fallback = parseInt(
  process.env.BILLING_BATCH_SIZE || process.env.BILLING_DEFAULT_BULLMQ_CONCURRENCY || '130',
  10
);
```

**After:**

```typescript
export function readBullmqConcurrency(): number {
  const fallback = parseInt(
    process.env.BILLING_BATCH_SIZE || process.env.BILLING_DEFAULT_BULLMQ_CONCURRENCY || '50',
    10
  );
  const raw = parseInt(process.env.BILLING_BULLMQ_CONCURRENCY || String(fallback), 10);
  if (!Number.isFinite(raw)) return 50;
  if (raw <= 0) return 0;
  return Math.min(200, Math.max(1, raw));
}

export async function getBillingQueueSnapshot(): Promise<{
  active: number;
  waiting: number;
  delayed: number;
  concurrency: number;
} | null> { ... }
```

**New doc:** `backend/docs/BILLING_CAPACITY_TUNING.md` — 25–30% step policy, required metrics before tuning, rollback worksheet.

**Production note:** code default is 50; production change still requires Milestone B signoff and staging validation.

---

## Contract tests added/extended

| Test file | What it guards |
|-----------|----------------|
| `admin-dashboard.contract.test.ts` | No `Creator.find({})` in `dashboardTopHosts`; no unbounded `CallHistory.find` in performance refunds |
| `creator-feed.contract.test.ts` | UIDs cache service, feed rank keys, shadow path, incremental cache sync |
| `creator-feed-rank.contract.test.ts` | `encodeFeedRankScore` tier + tie-break ordering |
| `bootstrap-ecs-metadata.contract.test.ts` | ECS metadata wiring in `load-env` |
| `billing.queue.contract.test.ts` | Default concurrency 50 |

Run targeted tests:

```bash
cd backend
npm run type-check
npx tsx --test src/modules/admin/admin-dashboard.contract.test.ts \
  src/modules/creator/creator-feed.contract.test.ts \
  src/modules/creator/creator-feed-rank.contract.test.ts \
  src/bootstrap/bootstrap-ecs-metadata.contract.test.ts \
  src/modules/billing/billing.queue.contract.test.ts
```

---

## Environment variables (new / documented)

Added to `backend/.env.example`:

```bash
# Phase 4 — feed rank (default off)
# CREATOR_FEED_REDIS_RANK_ENABLED=false
# CREATOR_FEED_RANK_SHADOW=false
# CREATOR_FEED_RANK_REBUILD=false
# CREATOR_FEED_AVAILABILITY_MAX_CATALOG=8000

# Phase 4 — admin performance idle window
# ADMIN_PERFORMANCE_INCLUDE_IDLE_DAYS=90

# Phase 5 — billing (staging-first tuning)
# BILLING_BULLMQ_CONCURRENCY=50
# BILLING_INSTANCE_ID=          # auto from ECS_CONTAINER_METADATA_URI_V4 when unset
```

---

## Rollback reference

| Change | Rollback knob | Target time |
|--------|---------------|-------------|
| PR2 feed rank | `CREATOR_FEED_REDIS_RANK_ENABLED=false` on all api-ws | < 15 min |
| 5B concurrency | Restore prior `BILLING_BULLMQ_CONCURRENCY` per task | < 15 min |
| PR1/PR3 bounds | Revert deploy commit | < 30 min |
| New Mongo indexes | Drop index only if plan regresses (prefer forward-fix) | Atlas-dependent |

---

## Post-merge operator steps

1. **Index audit (staging):** `npm run audit:mongo-indexes` — refresh `INDEX_MIGRATION_PLAN.md` with live explain stats; apply P0 indexes one at a time per rollout rules.
2. **PR2 shadow (staging):** `CREATOR_FEED_RANK_REBUILD=true` on deploy → `CREATOR_FEED_RANK_SHADOW=true` → monitor `creator.feed.rank_shadow_mismatch` and `presence.feedRankZcard`.
3. **5A load model (staging):** `npm run billing:load-model` with staging Redis/Mongo connected.
4. **Canary monitoring:** use updated `docs/CANARY_MONITORING_RUNBOOK.md` alert table during any billing/feed rollout.

---

## Related docs

- [INDEX_MIGRATION_PLAN.md](./INDEX_MIGRATION_PLAN.md)
- [CONNECTION_POOL_SIZING.md](./CONNECTION_POOL_SIZING.md)
- [BILLING_CAPACITY_TUNING.md](./BILLING_CAPACITY_TUNING.md)
- [CANARY_MONITORING_RUNBOOK.md](../../docs/CANARY_MONITORING_RUNBOOK.md)
