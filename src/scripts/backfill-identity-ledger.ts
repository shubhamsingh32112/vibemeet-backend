/**
 * Backfill IdentityLedger for existing users who already claimed the welcome bonus.
 * Run once after deploying the IdentityLedger feature to prevent bonus abuse by
 * users who claimed before deployment, then delete and reinstall.
 *
 * Run: npx tsx src/scripts/backfill-identity-ledger.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { User } from '../modules/user/user.model';
import { IdentityLedger } from '../modules/user/identity-ledger.model';

async function backfillIdentityLedger() {
  console.log('🔧 Backfill Identity Ledger Script');
  console.log('==================================\n');

  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('❌ MONGO_URI missing in .env');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('✅ MongoDB connected\n');

  const users = await User.find({
    welcomeBonusClaimed: true,
    role: { $ne: 'admin' },
  }).lean();

  console.log(`Found ${users.length} users who already claimed welcome bonus\n`);

  let created = 0;
  let skipped = 0;

  for (const user of users) {
    const doc: Record<string, unknown> = {
      bonusClaimed: true,
      firstUserId: user._id,
    };

    if (user.deviceFingerprint?.trim()) doc.deviceFingerprint = user.deviceFingerprint.trim();
    if (user.firebaseUid && !user.firebaseUid.startsWith('fast_')) doc.googleId = user.firebaseUid;
    if (user.phone?.trim()) doc.phone = user.phone.trim();

    if (!doc.deviceFingerprint && !doc.googleId && !doc.phone) {
      console.log(`  ⏭️  Skip user ${user._id}: no identity (no deviceFingerprint, googleId, or phone)`);
      skipped++;
      continue;
    }

    const orConditions: Record<string, unknown>[] = [];
    if (doc.deviceFingerprint) orConditions.push({ deviceFingerprint: doc.deviceFingerprint });
    if (doc.googleId) orConditions.push({ googleId: doc.googleId });
    if (doc.phone) orConditions.push({ phone: doc.phone });

    const existing = orConditions.length > 0
      ? await IdentityLedger.findOne({ $or: orConditions })
      : null;

    if (existing) {
      skipped++;
      continue;
    }

    await IdentityLedger.create(doc);
    created++;
    console.log(`  ✅ Recorded identity for user ${user._id}`);
  }

  console.log(`\n✅ Done: ${created} ledger entries created, ${skipped} skipped`);
  await mongoose.disconnect();
  process.exit(0);
}

backfillIdentityLedger().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
