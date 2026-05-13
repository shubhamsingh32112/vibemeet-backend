/**
 * One-time migration: denormalize User.firebaseUid onto Creator.firebaseUid.
 *
 * Run: npx tsx src/scripts/backfill-creator-firebase-uids.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { Creator } from '../modules/creator/creator.model';
import { User } from '../modules/user/user.model';

const BATCH_SIZE = 500;

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    // eslint-disable-next-line no-console
    console.error('MONGO_URI missing');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  // eslint-disable-next-line no-console
  console.log('Backfill Creator.firebaseUid — connected\n');

  let scanned = 0;
  let updated = 0;
  let skippedNoUser = 0;

  for (;;) {
    const creators = await Creator.find({
      $or: [{ firebaseUid: { $exists: false } }, { firebaseUid: null }, { firebaseUid: '' }],
    })
      .select('_id userId firebaseUid')
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .lean();

    if (creators.length === 0) break;
    scanned += creators.length;

    const userIds = creators
      .map((c) => c.userId)
      .filter((id): id is mongoose.Types.ObjectId => Boolean(id));
    const users = userIds.length
      ? await User.find({ _id: { $in: userIds } }).select('_id firebaseUid').lean()
      : [];
    const uidByUserId = new Map(users.map((u) => [u._id.toString(), u.firebaseUid || null] as const));

    const ops: Parameters<typeof Creator.bulkWrite>[0] = [];
    for (const c of creators) {
      const uid = c.userId ? uidByUserId.get(c.userId.toString()) : null;
      if (!uid || typeof uid !== 'string' || uid.trim() === '') {
        skippedNoUser += 1;
        continue;
      }
      ops.push({
        updateOne: {
          filter: { _id: c._id },
          update: { $set: { firebaseUid: uid.trim() } },
        },
      });
    }

    if (ops.length > 0) {
      const res = await Creator.bulkWrite(ops, { ordered: false });
      updated += res.modifiedCount ?? 0;
    }

    // eslint-disable-next-line no-console
    console.log(
      `  progress: scanned=${scanned}, updated=${updated}, skippedNoUser=${skippedNoUser}`,
    );
  }

  // eslint-disable-next-line no-console
  console.log(`\nDone: scanned=${scanned}, updated=${updated}, skippedNoUser=${skippedNoUser}`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});

