import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { Withdrawal } from '../modules/creator/withdrawal.model';
import { Creator } from '../modules/creator/creator.model';

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI missing');
    process.exit(1);
  }

  const dryRun = process.argv.includes('--dry-run');
  await mongoose.connect(mongoUri);
  console.log(`Connected to MongoDB (${dryRun ? 'dry-run' : 'write'} mode)`);

  const pendingUnassigned = await Withdrawal.find({
    status: 'pending',
    $or: [{ assignedAgencyId: { $exists: false } }, { assignedAgencyId: null }],
  })
    .select('_id creatorUserId assignedAgencyId')
    .lean();

  console.log(`Pending unassigned withdrawals: ${pendingUnassigned.length}`);
  if (pendingUnassigned.length === 0) {
    await mongoose.disconnect();
    return;
  }

  const creatorUserIds = [
    ...new Set(pendingUnassigned.map((row) => row.creatorUserId?.toString()).filter(Boolean)),
  ].map((id) => new mongoose.Types.ObjectId(id));

  const creators = await Creator.find({ userId: { $in: creatorUserIds } })
    .select('userId assignedAgencyId')
    .lean();
  const creatorByUserId = new Map(creators.map((c) => [c.userId.toString(), c]));

  let eligibleForAssign = 0;
  let updated = 0;
  let skipped = 0;

  for (const wd of pendingUnassigned) {
    const creatorUserId = wd.creatorUserId?.toString();
    if (!creatorUserId) {
      skipped += 1;
      continue;
    }
    const creator = creatorByUserId.get(creatorUserId);
    const assignedAgencyId = creator?.assignedAgencyId;
    if (!assignedAgencyId) {
      skipped += 1;
      continue;
    }
    eligibleForAssign += 1;
    if (!dryRun) {
      const result = await Withdrawal.updateOne(
        { _id: wd._id, status: 'pending', $or: [{ assignedAgencyId: { $exists: false } }, { assignedAgencyId: null }] },
        { $set: { assignedAgencyId } },
      );
      if (result.modifiedCount > 0) updated += 1;
    }
  }

  console.log(`Eligible for assignment: ${eligibleForAssign}`);
  console.log(`Updated: ${dryRun ? 0 : updated}`);
  console.log(`Skipped: ${skipped}`);

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error('reconcile-unassigned-withdrawals failed', error);
  process.exit(1);
});
