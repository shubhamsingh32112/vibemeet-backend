/**
 * Backfill onboarding permission-tracking fields for existing users.
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-onboarding-permission-fields.ts
 */
import mongoose from 'mongoose';
import { User } from '../src/modules/user/user.model';

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('Set MONGODB_URI');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const result = await User.updateMany(
    {},
    {
      $set: {
        cameraMicPermissionStatus: 'unknown',
        notificationPermissionStatus: 'unknown',
      },
      $setOnInsert: {
        permissionsIntroAcceptedAt: null,
        permissionsLastCheckedAt: null,
        lastPermissionsDecisionRequestId: null,
      },
    }
  );

  console.log(
    `Backfill complete. matched=${result.matchedCount} modified=${result.modifiedCount}`
  );
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
