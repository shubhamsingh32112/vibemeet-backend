/**
 * Post-migration read-only verification for agency ↔ BD hierarchy swap.
 *
 * Usage: npm run verify:agency-bd-swap
 */
import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { connectDatabase } from '../config/database';
import { User } from '../modules/user/user.model';
import { Creator } from '../modules/creator/creator.model';

const SAMPLE = 25;

async function main(): Promise<void> {
  await connectDatabase();

  const failures: string[] = [];

  const agentCount = await User.countDocuments({ role: 'agent' });
  if (agentCount !== 0) {
    failures.push(`Expected 0 users with role 'agent', found ${agentCount}`);
  }

  const oldCreatorField = await Creator.countDocuments({ assignedAgentId: { $exists: true } });
  if (oldCreatorField !== 0) {
    failures.push(`Expected 0 creators with assignedAgentId, found ${oldCreatorField}`);
  }

  const pendingBdApproval = await User.countDocuments({
    hostOnboardingStatus: 'pending_bd_approval',
  });
  if (pendingBdApproval !== 0) {
    failures.push(
      `Expected 0 users with pending_bd_approval, found ${pendingBdApproval}`
    );
  }

  const agencies = await User.find({ role: 'agency' })
    .select('_id bdId')
    .limit(SAMPLE)
    .lean();
  for (const a of agencies) {
    if (!a.bdId) continue;
    const parent = await User.findById(a.bdId).select('role').lean();
    if (!parent || parent.role !== 'bd') {
      failures.push(
        `Agency ${a._id.toString()} has invalid parent bdId ${a.bdId.toString()} (role=${parent?.role ?? 'missing'})`
      );
    }
  }

  const hosts = await Creator.find({ assignedAgencyId: { $exists: true, $ne: null } })
    .select('_id assignedAgencyId')
    .limit(SAMPLE)
    .lean();
  for (const h of hosts) {
    const agency = await User.findById(h.assignedAgencyId).select('role').lean();
    if (!agency || agency.role !== 'agency') {
      failures.push(
        `Creator ${h._id.toString()} assignedAgencyId ${h.assignedAgencyId?.toString()} is not role agency`
      );
    }
  }

  if (failures.length) {
    console.error('Hierarchy verification FAILED:\n' + failures.map((f) => `- ${f}`).join('\n'));
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log('Hierarchy verification passed.', {
    sampledAgencies: agencies.length,
    sampledHosts: hosts.length,
  });
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
