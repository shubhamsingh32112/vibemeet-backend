/**
 * Migration: add uploadRewardStatus fields to CreatorMoment.
 *
 * Backfill rules (priority order):
 *   1. CoinTransaction moment_upload_reward_{id} exists → approved
 *   2. createdAt < DEPLOYMENT_DATE → approved (historical moments)
 *   3. else → pending
 *
 * Usage:
 *   npx tsx migrations/20260702_add_upload_reward_status.ts
 *   npx tsx migrations/20260702_add_upload_reward_status.ts --dry-run
 */
import mongoose from 'mongoose';
import { UploadRewardStatus } from '../src/modules/moments/types/upload-reward-status';
import { connectMongoForMigration, disconnectMongo } from './lib/mongo-connect';

/** Moments created before this deploy are treated as already reviewed. */
const DEPLOYMENT_DATE = new Date('2026-07-02T00:00:00.000Z');

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  await connectMongoForMigration();
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database connection');

  const momentsCol = db.collection('creatormoments');
  const txCol = db.collection('cointransactions');

  const missingField = await momentsCol.countDocuments({
    uploadRewardStatus: { $exists: false },
  });
  console.log(`CreatorMoment missing uploadRewardStatus: ${missingField}`);

  const rewardTxIds = await txCol
    .find({ transactionId: /^moment_upload_reward_/ })
    .project({ transactionId: 1 })
    .toArray();
  const creditedMomentIds = new Set(
    rewardTxIds
      .map((tx) => {
        const id = String(tx.transactionId ?? '').replace('moment_upload_reward_', '');
        return id.length === 24 ? id : null;
      })
      .filter((id): id is string => id != null),
  );
  console.log(`Found ${creditedMomentIds.size} existing upload reward transactions`);

  const cursor = momentsCol.find({});
  let approvedByTx = 0;
  let approvedByDate = 0;
  let pending = 0;
  let skipped = 0;

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    if (!doc) break;

    const id = doc._id.toString();
    if (doc.uploadRewardStatus != null) {
      skipped += 1;
      continue;
    }

    let status: UploadRewardStatus;
    if (creditedMomentIds.has(id)) {
      status = UploadRewardStatus.Approved;
      approvedByTx += 1;
    } else if (doc.createdAt && new Date(doc.createdAt) < DEPLOYMENT_DATE) {
      status = UploadRewardStatus.Approved;
      approvedByDate += 1;
    } else {
      status = UploadRewardStatus.Pending;
      pending += 1;
    }

    const update = {
      uploadRewardStatus: status,
      uploadRewardApprovedAt:
        status === UploadRewardStatus.Approved ? doc.createdAt ?? new Date() : null,
      uploadRewardReviewedBy: null,
      uploadRewardReviewedAt:
        status === UploadRewardStatus.Approved ? doc.createdAt ?? new Date() : null,
    };

    if (!dryRun) {
      await momentsCol.updateOne({ _id: doc._id }, { $set: update });
    }
  }

  console.log(`Approved (coin tx): ${approvedByTx}`);
  console.log(`Approved (pre-deploy): ${approvedByDate}`);
  console.log(`Pending (post-deploy, no tx): ${pending}`);
  console.log(`Skipped (already set): ${skipped}`);
  if (dryRun) console.log('Dry run — no writes performed');

  await disconnectMongo();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
