/**
 * Mongo index audit — read-only. Outputs docs/INDEX_MIGRATION_PLAN.md
 *
 * Usage: npm run audit:mongo-indexes
 * Requires: MONGO_URI or MONGODB_URI
 */
import mongoose from 'mongoose';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Creator } from '../src/modules/creator/creator.model';
import { CallHistory } from '../src/modules/billing/call-history.model';
import { CreatorMoment } from '../src/modules/moments/models/creator-moment.model';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const OUT_PATH = join(__dirname, '../docs/INDEX_MIGRATION_PLAN.md');

type ExplainVerdict = 'PASS' | 'FAIL' | 'SKIP';

interface HotQueryResult {
  name: string;
  collection: string;
  verdict: ExplainVerdict;
  stage?: string;
  docsExamined?: number;
  nReturned?: number;
  ratio?: number;
  note?: string;
}

function indexKeyString(idx: { key: Record<string, number> }): string {
  return JSON.stringify(idx.key);
}

async function listDbIndexes(collectionName: string): Promise<string[]> {
  const db = mongoose.connection.db;
  if (!db) return [];
  const indexes = await db.collection(collectionName).indexes();
  return indexes.map((i) => indexKeyString(i as { key: Record<string, number> }));
}

function schemaIndexKeys(model: mongoose.Model<unknown>): string[] {
  return model.schema.indexes().map(([fields]) => JSON.stringify(fields));
}

function classifyExplain(stats: Record<string, unknown> | undefined): {
  verdict: ExplainVerdict;
  stage?: string;
  docsExamined?: number;
  nReturned?: number;
  ratio?: number;
} {
  if (!stats) return { verdict: 'SKIP', note: 'no stats' } as never;
  const exec = stats as {
    executionStats?: {
      executionStages?: { stage?: string; inputStage?: { stage?: string } };
      totalDocsExamined?: number;
      nReturned?: number;
    };
  };
  const es = exec.executionStats;
  if (!es) return { verdict: 'SKIP' };
  const stage = es.executionStages?.stage ?? es.executionStages?.inputStage?.stage ?? 'unknown';
  const docsExamined = es.totalDocsExamined ?? 0;
  const nReturned = Math.max(es.nReturned ?? 1, 1);
  const ratio = docsExamined / nReturned;
  const collscan = String(stage).includes('COLLSCAN');
  const fail = collscan || ratio > 10;
  return {
    verdict: fail ? 'FAIL' : 'PASS',
    stage: String(stage),
    docsExamined,
    nReturned: es.nReturned ?? 0,
    ratio: Math.round(ratio * 100) / 100,
  };
}

async function explainHotQueries(): Promise<HotQueryResult[]> {
  const results: HotQueryResult[] = [];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const adminPerf = await CallHistory.collection
    .aggregate([
      {
        $match: {
          ownerRole: 'creator',
          durationSeconds: { $gt: 0 },
          createdAt: { $gte: thirtyDaysAgo },
        },
      },
      { $group: { _id: '$ownerUserId', calls: { $sum: 1 } } },
      { $limit: 100 },
    ])
    .explain('executionStats');
  const adminClass = classifyExplain(adminPerf as Record<string, unknown>);
  results.push({
    name: 'admin_creator_performance_30d_group',
    collection: 'callhistories',
    ...adminClass,
  });

  const creatorUid = await Creator.collection
    .find({ firebaseUid: { $exists: true, $ne: '' } })
    .project({ firebaseUid: 1 })
    .limit(100)
    .explain('executionStats');
  const uidClass = classifyExplain(creatorUid as Record<string, unknown>);
  results.push({
    name: 'creator_firebase_uid_catalog_scan',
    collection: 'creators',
    ...uidClass,
  });

  const momentAnalytics = await CreatorMoment.collection
    .aggregate([
      { $match: { isDeleted: false } },
      { $group: { _id: '$creatorId', c: { $sum: 1 } } },
      { $limit: 50 },
    ])
    .explain('executionStats');
  const momentClass = classifyExplain(momentAnalytics as Record<string, unknown>);
  results.push({
    name: 'creator_moment_post_count_by_creator',
    collection: 'creatormoments',
    ...momentClass,
  });

  return results;
}

async function main(): Promise<void> {
  if (!MONGO_URI) {
    console.error('MONGO_URI or MONGODB_URI required');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);

  const collections: Array<{ name: string; model: mongoose.Model<unknown> }> = [
    { name: 'creators', model: Creator as mongoose.Model<unknown> },
    { name: 'callhistories', model: CallHistory as mongoose.Model<unknown> },
    { name: 'creatormoments', model: CreatorMoment as mongoose.Model<unknown> },
  ];

  const indexDiffLines: string[] = [];
  for (const { name, model } of collections) {
    const schemaIdx = new Set(schemaIndexKeys(model));
    const dbIdx = new Set(await listDbIndexes(name));
    const missing = [...schemaIdx].filter((k) => !dbIdx.has(k));
    const extra = [...dbIdx].filter((k) => !schemaIdx.has(k) && k !== '{"_id":1}');
    indexDiffLines.push(`### ${name}`);
    indexDiffLines.push(`- Schema indexes: ${schemaIdx.size}`);
    indexDiffLines.push(`- Atlas indexes: ${dbIdx.size}`);
    if (missing.length) indexDiffLines.push(`- **Missing in Atlas:** ${missing.join(', ')}`);
    if (extra.length) indexDiffLines.push(`- Extra in Atlas: ${extra.join(', ')}`);
    indexDiffLines.push('');
  }

  const hotQueries = await explainHotQueries();

  const recommendations = [
    {
      priority: 'P0',
      collection: 'callhistories',
      index: '{ ownerRole: 1, ownerUserId: 1, createdAt: -1 }',
      rationale: 'Admin performance aggregations by creator + date',
      rollout: 'pending',
    },
    {
      priority: 'P0',
      collection: 'creators',
      index: '{ firebaseUid: 1 } sparse',
      rationale: 'UID catalog stream / rank rebuild',
      rollout: 'pending',
    },
    {
      priority: 'P1',
      collection: 'creatormoments',
      index: '{ creatorId: 1, isDeleted: 1 }',
      rationale: 'Moments analytics countDocuments',
      rollout: 'pending',
    },
  ];

  const md = `# INDEX_MIGRATION_PLAN

Generated: ${new Date().toISOString()}

## Explain thresholds (staging targets)

| Threshold | Target |
|-----------|--------|
| Collection scan | No COLLSCAN on hot paths |
| docsExamined / nReturned | <= 10x |
| p95 aggregation runtime | < 300ms (validate in staging) |

## Index diff (schema vs Atlas)

${indexDiffLines.join('\n')}

## Hot query explain results

| Query | Collection | Verdict | Stage | docsExamined | nReturned | Ratio |
|-------|------------|---------|-------|--------------|-----------|-------|
${hotQueries
  .map(
    (q) =>
      `| ${q.name} | ${q.collection} | ${q.verdict} | ${q.stage ?? '-'} | ${q.docsExamined ?? '-'} | ${q.nReturned ?? '-'} | ${q.ratio ?? '-'} |`
  )
  .join('\n')}

## Recommended index rollouts

| Priority | Collection | Index | Rationale | Rollout status |
|----------|------------|-------|-----------|----------------|
${recommendations
  .map(
    (r) =>
      `| ${r.priority} | ${r.collection} | \`${r.index}\` | ${r.rationale} | ${r.rollout} |`
  )
  .join('\n')}

## Rollout safety rules

1. Create indexes in **staging** first
2. **One** production index per change window
3. Observe replication lag + CPU during build
4. Do **not** combine production index builds with PR2 ranking, 5B concurrency, or Redis topology changes

## Redis key registry (Phase 4 persistent structures)

| Key | Owner | TTL | Cleanup | Fallback |
|-----|-------|-----|---------|----------|
| creator:feed:rank:v1 | api-ws / feed-rank | No TTL; catalog cap | DEL on flag-off; ZREM on delete | Legacy in-memory sort |
| creator:uids:set:v1 | api-ws / creator-uids-cache | CREATOR_UIDS_TTL | invalidateCreatorCatalogCaches | Mongo cursor stream |
`;

  writeFileSync(OUT_PATH, md, 'utf8');
  console.log(`Wrote ${OUT_PATH}`);
  console.log(
    'Hot queries:',
    hotQueries.map((q) => `${q.name}=${q.verdict}`).join(', ')
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
