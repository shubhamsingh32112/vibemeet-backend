/**
 * Migration: add likesCount and commentsCount to CreatorMoment (default 0).
 *
 * Usage:
 *   npx tsx migrations/20260701_add_moment_engagement_counts.ts
 *   npx tsx migrations/20260701_add_moment_engagement_counts.ts --dry-run
 */
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/zztherapy';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database connection');

  const collection = db.collection('creatormoments');
  const missingLikes = await collection.countDocuments({ likesCount: { $exists: false } });
  const missingComments = await collection.countDocuments({ commentsCount: { $exists: false } });
  console.log(`CreatorMoment missing likesCount: ${missingLikes}`);
  console.log(`CreatorMoment missing commentsCount: ${missingComments}`);

  if (!dryRun) {
    if (missingLikes > 0) {
      const result = await collection.updateMany(
        { likesCount: { $exists: false } },
        { $set: { likesCount: 0 } },
      );
      console.log(`Set likesCount=0 on ${result.modifiedCount} documents`);
    }
    if (missingComments > 0) {
      const result = await collection.updateMany(
        { commentsCount: { $exists: false } },
        { $set: { commentsCount: 0 } },
      );
      console.log(`Set commentsCount=0 on ${result.modifiedCount} documents`);
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
