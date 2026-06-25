/**
 * Migration: remove per-moment coin monetization fields from CreatorMoment.
 *
 * Usage:
 *   npx tsx backend/migrations/20260626_remove_moment_coin_model.ts
 *   npx tsx backend/migrations/20260626_remove_moment_coin_model.ts --dry-run
 */
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/zztherapy';

async function verifyNoLegacyFields(db: mongoose.mongo.Db): Promise<void> {
  const collection = db.collection('creatormoments');
  const withAccessType = await collection.countDocuments({ accessType: { $exists: true } });
  const withPriceCoins = await collection.countDocuments({ priceCoins: { $exists: true } });
  if (withAccessType > 0 || withPriceCoins > 0) {
    throw new Error(
      `Verification failed: ${withAccessType} docs still have accessType, ${withPriceCoins} still have priceCoins`,
    );
  }
  console.log('Verified: no CreatorMoment documents contain accessType or priceCoins');
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const verifyOnly = process.argv.includes('--verify');
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database connection');

  const collection = db.collection('creatormoments');
  const freeCount = await collection.countDocuments({ accessType: 'free' });
  const paidCount = await collection.countDocuments({ accessType: 'paid' });
  console.log(`Found accessType free=${freeCount} paid=${paidCount}`);

  if (verifyOnly) {
    await verifyNoLegacyFields(db);
    await mongoose.disconnect();
    return;
  }

  if (dryRun) {
    console.log('[dry-run] Would $unset accessType and priceCoins on all CreatorMoment documents');
    await mongoose.disconnect();
    return;
  }

  const result = await collection.updateMany(
    {},
    { $unset: { accessType: '', priceCoins: '' } },
  );
  console.log(`Unset accessType/priceCoins on ${result.modifiedCount} documents`);

  await verifyNoLegacyFields(db);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
