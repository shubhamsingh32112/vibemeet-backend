/**
 * Migration: add isVipHighlighted to MomentComment (default false).
 *
 * Usage:
 *   npx tsx migrations/20260702_add_vip_highlight_flag.ts
 *   npx tsx migrations/20260702_add_vip_highlight_flag.ts --dry-run
 */
import mongoose from 'mongoose';
import { connectMongoForMigration, disconnectMongo } from './lib/mongo-connect';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  await connectMongoForMigration();
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database connection');

  const collection = db.collection('momentcomments');
  const missing = await collection.countDocuments({ isVipHighlighted: { $exists: false } });
  console.log(`MomentComment missing isVipHighlighted: ${missing}`);

  if (!dryRun && missing > 0) {
    const result = await collection.updateMany(
      { isVipHighlighted: { $exists: false } },
      { $set: { isVipHighlighted: false } },
    );
    console.log(`Set isVipHighlighted=false on ${result.modifiedCount} documents`);
  } else if (dryRun) {
    console.log('Dry run — no writes performed');
  }

  await disconnectMongo();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
