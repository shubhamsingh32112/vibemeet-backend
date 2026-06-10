# MongoDB Connection Pool Sizing

Per-process pool sizing for ECS multi-service split. Scale **out** (more tasks) before raising per-task pools.

## Formula

```
total_connections = Σ (MONGO_POOL_SIZE × task_count) per role
```

Must stay **below** Atlas tier connection limit (e.g. M30 ≈ 500).

## Target topology (Phase 6 reference)

| Service | Tasks | MONGO_POOL_SIZE | Subtotal |
|---------|-------|-----------------|----------|
| api-ws | 4 | 40 | 160 |
| billing-worker | 2 | 25 | 50 |
| moments-worker | 1 | 12 | 12 |
| image-worker | 1 | 8 | 8 |
| **Total** | | | **230** |

Headroom ~270 connections on M30 for ops tooling and migrations.

## Per-role env blocks

```bash
# api-ws task definition
MONGO_POOL_SIZE=40
MONGO_MIN_POOL_SIZE=5

# billing-worker
MONGO_POOL_SIZE=25
MONGO_MIN_POOL_SIZE=5

# moments-worker
MONGO_POOL_SIZE=12
MONGO_MIN_POOL_SIZE=3

# image-worker
MONGO_POOL_SIZE=8
MONGO_MIN_POOL_SIZE=2
```

## Alerts

- `/metrics` → `mongo.poolUtilization` > **0.8** → investigate before scaling pool up
- `mongo.poolUtilization` > **0.95** → hard capacity signal; prefer adding tasks or Atlas tier upgrade

## Railway vs ECS

Never use `MONGO_POOL_SIZE=1500` on multi-task ECS. Railway single-replica pools do not transfer.

## Rollback

1. Reduce **task count** before raising `MONGO_POOL_SIZE`
2. Lower per-task pool in task definition → rolling deploy
3. Verify `/ready` and `mongo.poolUtilization` after deploy

## Related

- [database.ts](../src/config/database.ts) — pool defaults (50 / 5)
- [AWS_BACKEND_DEPLOYMENT_GUIDE.md](./AWS_BACKEND_DEPLOYMENT_GUIDE.md) — ECS env templates
