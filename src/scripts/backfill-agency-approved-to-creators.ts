/**
 * Backfill: promote agency-referred users who were marked approved (old flow)
 * but never got a Creator row. Uses the same starter profile as agency Approve.
 *
 * Preview (no writes):
 *   npx tsx src/scripts/backfill-agency-approved-to-creators.ts
 *
 * Apply:
 *   APPLY=1 npx tsx src/scripts/backfill-agency-approved-to-creators.ts
 *
 * Single user:
 *   USER_ID=<mongoUserId> APPLY=1 npx tsx src/scripts/backfill-agency-approved-to-creators.ts
 *
 * Also promote pending agency referrals (optional):
 *   INCLUDE_PENDING=1 APPLY=1 npx tsx src/scripts/backfill-agency-approved-to-creators.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { User } from '../modules/user/user.model';
import { Creator } from '../modules/creator/creator.model';
import { promoteUserToCreatorWithStarterProfile } from '../modules/creator/creator-starter.service';
import { isAgencyRole } from '../utils/staff-roles';

const PROMOTABLE_STATUSES_APPROVED_ONLY = ['approved'] as const;
const PROMOTABLE_STATUSES_WITH_PENDING = [
  'approved',
  'pending_agency_approval',
  'pending_bd_approval',
] as const;

async function main() {
  const apply = process.env.APPLY === '1' || process.env.APPLY === 'true';
  const includePending =
    process.env.INCLUDE_PENDING === '1' || process.env.INCLUDE_PENDING === 'true';
  const userIdFilter = process.env.USER_ID?.trim();

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGO_URI missing — set it in backend/.env or run via:');
    console.error(
      '  powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/with-dev-env.ps1 tsx src/scripts/backfill-agency-approved-to-creators.ts',
    );
    process.exit(1);
  }

  try {
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('\nCould not connect to MongoDB.\n');
    if (/whitelist|ServerSelection|ReplicaSetNoPrimary/i.test(msg)) {
      console.error('Atlas is reachable but blocked or has no primary. Usually:');
      console.error('  1. Add your current public IP in MongoDB Atlas → Network Access');
      console.error('     https://cloud.mongodb.com → your cluster → Network Access → Add IP');
      console.error('  2. Or use "Allow access from anywhere" (0.0.0.0/0) for dev only');
      console.error('  3. Retry after 1–2 minutes if you just whitelisted');
      console.error('\nAlternative: use Agency dashboard → Referred users → Approve on each row');
      console.error('(works if the deployed API can reach Atlas).\n');
    }
    console.error(msg);
    process.exit(1);
  }
  console.log('Connected.\n');
  console.log(`Mode: ${apply ? 'APPLY (writes enabled)' : 'DRY RUN (preview only)'}`);
  console.log(
    `Statuses: ${includePending ? PROMOTABLE_STATUSES_WITH_PENDING.join(', ') : PROMOTABLE_STATUSES_APPROVED_ONLY.join(', ')}`,
  );
  if (userIdFilter) console.log(`Filter USER_ID: ${userIdFilter}`);
  console.log('');

  const creatorUserIds = await Creator.distinct('userId');
  const creatorUserIdSet = new Set(creatorUserIds.map((id) => id.toString()));

  const statuses = includePending
    ? [...PROMOTABLE_STATUSES_WITH_PENDING]
    : [...PROMOTABLE_STATUSES_APPROVED_ONLY];

  const query: Record<string, unknown> = {
    referredBy: { $exists: true, $ne: null },
    hostOnboardingStatus: { $in: statuses },
    role: { $ne: 'creator' },
  };
  if (userIdFilter) {
    if (!mongoose.isValidObjectId(userIdFilter)) {
      console.error('Invalid USER_ID');
      process.exit(1);
    }
    query._id = new mongoose.Types.ObjectId(userIdFilter);
  }

  const candidates = await User.find(query)
    .select('_id email username phone referredBy hostOnboardingStatus role')
    .lean();

  const eligible: Array<{
    userId: string;
    email?: string;
    username?: string;
    hostOnboardingStatus: string;
    agencyId: string;
  }> = [];

  for (const u of candidates) {
    if (creatorUserIdSet.has(u._id.toString())) continue;
    if (!u.referredBy) continue;

    const referrer = await User.findById(u.referredBy).select('role email displayName').lean();
    if (!referrer) {
      console.warn(`  skip ${u._id}: referrer ${u.referredBy} not found`);
      continue;
    }
    const referrerRole = String(referrer.role ?? '');
    const referrerIsAgency =
      isAgencyRole(referrer.role) || referrerRole === 'agent';
    if (!referrerIsAgency) {
      console.warn(
        `  skip ${u._id}: referrer role=${referrer.role} (not agency)`,
      );
      continue;
    }

    eligible.push({
      userId: u._id.toString(),
      email: u.email,
      username: u.username,
      hostOnboardingStatus: String(u.hostOnboardingStatus ?? 'none'),
      agencyId: u.referredBy.toString(),
    });
  }

  console.log(`Candidates scanned: ${candidates.length}`);
  console.log(`Eligible for promotion: ${eligible.length}\n`);

  if (eligible.length === 0) {
    await mongoose.disconnect();
    console.log('Nothing to do.');
    return;
  }

  for (const row of eligible) {
    console.log(
      `  - ${row.userId} | ${row.username ?? row.email ?? 'no label'} | status=${row.hostOnboardingStatus} | agency=${row.agencyId}`,
    );
  }
  console.log('');

  if (!apply) {
    console.log('DRY RUN — set APPLY=1 to promote these users.\n');
    await mongoose.disconnect();
    return;
  }

  let promoted = 0;
  let failed = 0;

  for (const row of eligible) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const targetUser = await User.findById(row.userId).session(session);
        if (!targetUser) {
          throw new Error('user not found');
        }
        if (!targetUser.referredBy?.equals(new mongoose.Types.ObjectId(row.agencyId))) {
          throw new Error('referredBy mismatch');
        }
        const existing = await Creator.findOne({ userId: targetUser._id })
          .session(session)
          .select('_id')
          .lean();
        if (existing) {
          throw new Error('creator already exists');
        }

        targetUser.hostOnboardingStatus = 'none';
        if (!targetUser.agencyApprovedAt) {
          targetUser.agencyApprovedAt = new Date();
        }
        targetUser.profileRevision = (targetUser.profileRevision ?? 0) + 1;

        const created = await promoteUserToCreatorWithStarterProfile(targetUser, {
          assignedAgencyId: new mongoose.Types.ObjectId(row.agencyId),
          session,
        });

        console.log(
          `  promoted ${row.userId} -> creator ${created._id.toString()}`,
        );
        promoted += 1;
      });
    } catch (err) {
      failed += 1;
      console.error(`  FAILED ${row.userId}:`, err instanceof Error ? err.message : err);
    } finally {
      await session.endSession();
    }
  }

  console.log(`\nDone. promoted=${promoted} failed=${failed}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
