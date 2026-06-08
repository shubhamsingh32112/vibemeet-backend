/**
 * Milestone A staging signoff: assert no duplicate billing debit rows per call + bucket.
 *
 * Usage: tsx scripts/assert-no-double-settlement.ts
 * Requires MONGODB_URI (or existing app mongo connection env).
 */
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

async function main(): Promise<void> {
  if (!MONGO_URI) {
    console.error('MONGODB_URI or MONGO_URI required');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  if (!db) {
    console.error('Mongo connection failed');
    process.exit(1);
  }

  const duplicates = await db
    .collection('cointransactions')
    .aggregate([
      { $match: { type: 'debit', source: 'billing' } },
      {
        $group: {
          _id: { callId: '$callId', bucket: '$billingSequence' },
          count: { $sum: 1 },
          ids: { $push: '$_id' },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  if (duplicates.length === 0) {
    console.log('PASS: no duplicate billing settlement rows');
    await mongoose.disconnect();
    process.exit(0);
  }

  console.error(`FAIL: ${duplicates.length} duplicate billing window(s) found`);
  console.error(JSON.stringify(duplicates, null, 2));
  await mongoose.disconnect();
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
