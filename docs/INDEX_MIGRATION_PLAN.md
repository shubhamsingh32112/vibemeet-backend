# INDEX_MIGRATION_PLAN

Run `npm run audit:mongo-indexes` against staging/prod Atlas to refresh this document with live explain stats.

## Explain thresholds (staging targets)

| Threshold | Target |
|-----------|--------|
| Collection scan | No COLLSCAN on hot paths |
| docsExamined / nReturned | <= 10x |
| p95 aggregation runtime | < 300ms |

## Recommended index rollouts

| Priority | Collection | Index | Rationale | Rollout status |
|----------|------------|-------|-----------|----------------|
| P0 | callhistories | `{ ownerRole: 1, ownerUserId: 1, createdAt: -1 }` | Admin performance aggregations | schema-declared — apply staging first |
| P0 | creators | `{ firebaseUid: 1 }` sparse | UID catalog / rank rebuild | schema-declared — apply staging first |
| P1 | creatormoments | `{ creatorId: 1, isDeleted: 1 }` | Moments analytics counts | schema-declared — apply staging first |

## Rollout safety rules

1. Staging first
2. One production index per change window
3. Observe replication lag + CPU during build
4. Do not combine production index builds with PR2 ranking, 5B concurrency, or Redis topology changes

## Redis key registry (Phase 4)

| Key | Owner | TTL | Cleanup | Fallback |
|-----|-------|-----|---------|----------|
| creator:feed:rank:v1 | api-ws / feed-rank | No TTL; catalog cap | DEL on flag-off; ZREM on delete | Legacy in-memory sort |
| creator:uids:set:v1 | api-ws / creator-uids-cache | CREATOR_UIDS_TTL | invalidateCreatorCatalogCaches | Mongo cursor stream |
