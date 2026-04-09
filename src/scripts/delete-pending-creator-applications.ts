/**
 * One-time migration: remove legacy pending CreatorApplication documents after switching
 * to promotion via agent/admin dashboard (no mobile verification queue).
 *
 * Run: npx tsx src/scripts/delete-pending-creator-applications.ts
 * Dry-run (no delete): DRY_RUN=1 npx tsx src/scripts/delete-pending-creator-applications.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { CreatorApplication } from '../modules/agent/creator-application.model';

async function main() {
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI missing');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('Connected.\n');

  const pending = await CreatorApplication.find({ status: 'pending' }).select('_id').lean();
  console.log(`Pending CreatorApplication documents: ${pending.length}`);
  if (dryRun) {
    console.log('DRY_RUN=1 — no documents deleted.\n');
    await mongoose.disconnect();
    return;
  }

  const res = await CreatorApplication.deleteMany({ status: 'pending' });
  console.log(`Deleted: ${res.deletedCount}\n`);

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
