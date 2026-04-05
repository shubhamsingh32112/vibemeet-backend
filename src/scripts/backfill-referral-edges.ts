/**
 * Create ReferralEdge rows for users who have referredBy + referrer referrals[]
 * but no ReferralEdge yet (legacy data before this collection existed).
 *
 * Run: npx tsx src/scripts/backfill-referral-edges.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { User } from '../modules/user/user.model';
import { ensureReferralEdgeForReferredUser } from '../modules/user/referral.service';

async function main() {
  console.log('Backfill ReferralEdge');
  console.log('=====================\n');

  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI missing');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('Connected.\n');

  const users = await User.find({ referredBy: { $ne: null } }).select('_id').lean();
  console.log(`Users with referredBy: ${users.length}\n`);

  let ok = 0;
  let err = 0;
  for (const u of users) {
    try {
      await ensureReferralEdgeForReferredUser(u._id);
      ok++;
    } catch (e) {
      err++;
      console.error(`  Failed ${u._id}:`, e);
    }
  }

  console.log(`\nDone: ${ok} processed, ${err} errors`);
  await mongoose.disconnect();
  process.exit(err > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
