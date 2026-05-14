/**
 * One-shot migration: invert staff hierarchy
 *   super_admin → agency (top) → bd/agent (mid) → hosts
 * becomes
 *   super_admin → bd (top) → agency (mid) → hosts
 *
 * Usage:
 *   npx tsx src/scripts/migrate-agency-bd-hierarchy-swap.ts          # dry-run
 *   npx tsx src/scripts/migrate-agency-bd-hierarchy-swap.ts --apply
 */
import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { connectDatabase } from '../config/database';
import { User } from '../modules/user/user.model';
import { Creator } from '../modules/creator/creator.model';
import { Withdrawal } from '../modules/creator/withdrawal.model';
import { StaffWalletLedger } from '../modules/billing/staff-wallet-ledger.model';

const TEMP_TOP = '__swap_top__';
const TEMP_MID = '__swap_mid__';
const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  await connectDatabase();

  const countsBefore = {
    agency: await User.countDocuments({ role: 'agency' }),
    bd: await User.countDocuments({ role: 'bd' }),
    agent: await User.countDocuments({ role: 'agent' }),
  };
  console.log('Counts before:', countsBefore);

  if (!APPLY) {
    console.log('DRY RUN — pass --apply to execute');
    await mongoose.disconnect();
    return;
  }

  // 1. Temp roles
  await User.updateMany({ role: 'agency' }, { $set: { role: TEMP_TOP } });
  await User.updateMany({ role: { $in: ['bd', 'agent'] } }, { $set: { role: TEMP_MID } });

  // 2. Remap fields on temp roles
  const midUsers = await User.find({ role: TEMP_MID }).select('_id agencyId agentDisabled agencyDisabled bdDisabled');
  for (const u of midUsers) {
    const legacyAgencyId = (u as { agencyId?: mongoose.Types.ObjectId }).agencyId;
    const legacyAgentDisabled = (u as { agentDisabled?: boolean }).agentDisabled;
    await User.updateOne(
      { _id: u._id },
      {
        $set: {
          bdId: legacyAgencyId,
          agencyDisabled: legacyAgentDisabled ?? false,
        },
        $unset: { agencyId: '', agentDisabled: '' },
      }
    );
  }

  const topUsers = await User.find({ role: TEMP_TOP }).select('_id agencyDisabled bdDisabled');
  for (const u of topUsers) {
    const legacyAgencyDisabled = (u as { agencyDisabled?: boolean }).agencyDisabled;
    await User.updateOne(
      { _id: u._id },
      {
        $set: { bdDisabled: legacyAgencyDisabled ?? false },
        $unset: { agencyDisabled: '' },
      }
    );
  }

  // 3. Finalize roles
  await User.updateMany({ role: TEMP_TOP }, { $set: { role: 'bd' } });
  await User.updateMany({ role: TEMP_MID }, { $set: { role: 'agency' } });

  // 4. Creators: assignedAgentId → assignedAgencyId
  const creators = await Creator.find({ assignedAgentId: { $exists: true } }).select('_id assignedAgentId');
  for (const c of creators) {
    const legacy = (c as { assignedAgentId?: mongoose.Types.ObjectId }).assignedAgentId;
    if (!legacy) continue;
    await Creator.updateOne(
      { _id: c._id },
      { $set: { assignedAgencyId: legacy }, $unset: { assignedAgentId: '' } }
    );
  }

  // 5. Withdrawals denormalized field
  await Withdrawal.updateMany(
    { assignedAgentId: { $exists: true } },
    [{ $set: { assignedAgencyId: '$assignedAgentId' } }, { $unset: ['assignedAgentId'] }]
  ).catch(async () => {
    const wds = await Withdrawal.find({ assignedAgentId: { $exists: true } });
    for (const w of wds) {
      const legacy = (w as { assignedAgentId?: mongoose.Types.ObjectId }).assignedAgentId;
      if (legacy) {
        await Withdrawal.updateOne(
          { _id: w._id },
          { $set: { assignedAgencyId: legacy }, $unset: { assignedAgentId: '' } }
        );
      }
    }
  });

  // 6. Onboarding status strings
  await User.updateMany(
    { hostOnboardingStatus: 'pending_bd_approval' },
    { $set: { hostOnboardingStatus: 'pending_agency_approval' } }
  );
  await User.updateMany(
    { bdApprovedAt: { $exists: true } },
    [{ $rename: { bdApprovedAt: 'agencyApprovedAt' } }]
  ).catch(() => undefined);

  // 7. Ledger bdUserId/agencyUserId — swap semantics: old agencyUserId was top org, old bdUserId was mid
  const ledgers = await StaffWalletLedger.find({}).select('bdUserId agencyUserId');
  for (const row of ledgers) {
    const oldBd = row.bdUserId;
    const oldAgency = row.agencyUserId;
    if (!oldBd && !oldAgency) continue;
    await StaffWalletLedger.updateOne(
      { _id: row._id },
      { $set: { bdUserId: oldAgency, agencyUserId: oldBd } }
    );
  }

  const countsAfter = {
    bd: await User.countDocuments({ role: 'bd' }),
    agency: await User.countDocuments({ role: 'agency' }),
    agent: await User.countDocuments({ role: 'agent' }),
    creatorsOldField: await Creator.countDocuments({ assignedAgentId: { $exists: true } }),
  };
  console.log('Counts after:', countsAfter);
  console.log('Redis: flush creator:staff_scope:* and presence:online_by_agency:* after deploy');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
