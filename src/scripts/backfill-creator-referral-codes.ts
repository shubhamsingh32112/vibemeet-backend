/**
 * Backfill CR- referral codes for existing creators.
 *
 * Run: npx tsx src/scripts/backfill-creator-referral-codes.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { User } from '../modules/user/user.model';
import { assignCreatorReferralCode } from '../modules/user/referral.service';
import { isCreatorReferralCodeFormat } from '../utils/referral-code';

async function backfillCreatorReferralCodes() {
  console.log('🔧 Backfill Creator Referral Codes (CR-)');
  console.log('========================================\n');

  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('❌ MONGO_URI missing in .env');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('✅ MongoDB connected\n');

  const creators = await User.find({ role: 'creator' });
  console.log(`Found ${creators.length} creators\n`);

  let assigned = 0;
  let skipped = 0;
  let errors = 0;

  for (const user of creators) {
    try {
      if (user.referralCode && isCreatorReferralCodeFormat(user.referralCode)) {
        skipped++;
        continue;
      }
      const prev = user.referralCode ?? '(none)';
      const code = await assignCreatorReferralCode(user);
      assigned++;
      console.log(`  ✅ User ${user._id}: ${prev} → ${code}`);
    } catch (err) {
      errors++;
      console.error(`  ❌ User ${user._id}:`, err);
    }
  }

  console.log(
    `\n✅ Done: ${assigned} assigned, ${skipped} already CR-, ${errors} errors`
  );
  await mongoose.disconnect();
  process.exit(errors > 0 ? 1 : 0);
}

backfillCreatorReferralCodes().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
