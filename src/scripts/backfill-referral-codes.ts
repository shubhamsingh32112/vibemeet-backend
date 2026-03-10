/**
 * Backfill referral codes for existing users who don't have one.
 * Run once after deploying the referral system.
 *
 * Run: npx tsx src/scripts/backfill-referral-codes.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { User } from '../modules/user/user.model';
import { assignReferralCodeToUser } from '../modules/user/referral.service';

async function backfillReferralCodes() {
  console.log('🔧 Backfill Referral Codes Script');
  console.log('=================================\n');

  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('❌ MONGO_URI missing in .env');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('✅ MongoDB connected\n');

  const users = await User.find({
    $or: [{ referralCode: { $exists: false } }, { referralCode: null }, { referralCode: '' }],
  });

  console.log(`Found ${users.length} users without referral code\n`);

  let assigned = 0;
  let errors = 0;

  for (const user of users) {
    try {
      await assignReferralCodeToUser(user);
      assigned++;
      console.log(`  ✅ User ${user._id}: ${user.referralCode}`);
    } catch (err) {
      errors++;
      console.error(`  ❌ User ${user._id}:`, err);
    }
  }

  console.log(`\n✅ Done: ${assigned} referral codes assigned, ${errors} errors`);
  await mongoose.disconnect();
  process.exit(errors > 0 ? 1 : 0);
}

backfillReferralCodes().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
