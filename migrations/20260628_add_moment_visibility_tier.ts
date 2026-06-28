/**
 * Migration: add visibilityTier to CreatorMoment (default PUBLIC).
 *
 * Usage:
 *   npx tsx backend/migrations/20260628_add_moment_visibility_tier.ts
 *   npx tsx backend/migrations/20260628_add_moment_visibility_tier.ts --dry-run
 */
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/zztherapy';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database connection');

  const collection = db.collection('creatormoments');
  const missing = await collection.countDocuments({ visibilityTier: { $exists: false } });
  console.log(`CreatorMoment documents missing visibilityTier: ${missing}`);

  if (!dryRun && missing > 0) {
    const result = await collection.updateMany(
      { visibilityTier: { $exists: false } },
      { $set: { visibilityTier: 'PUBLIC' } },
    );
    console.log(`Updated ${result.modifiedCount} documents to visibilityTier=PUBLIC`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
